import fs from 'fs';
import path from 'path';
import os from 'os';
import { isRecord, truncateText, classifyTailEntry, TOOL_USE_INPUT_LIMIT, TOOL_RESULT_TEXT_LIMIT, TAIL_STATE_SCAN_BYTES } from './entryHelpers';
import { readChunk, readInitialWindow, readIncrementalWindow, readBeforeWindow } from './jsonlWindowReader';
import type {
  ReadSessionBeforeResult,
  ReadSessionResult,
  SessionSummary,
  TranscriptBlock,
  TranscriptEntry,
  TranscriptEntryType,
  TranscriptSource,
} from './TranscriptSource';

// ─── Constants ───

const PREVIEW_LENGTH = 120;
const PREVIEW_SCAN_LINES = 20;
const TAIL_ENTRY_LIMIT = 500;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 初回読みで末尾から遡って読む最大バイト数。これを超える古い部分は初回表示対象外（truncated: true）。 */
const DEFAULT_INITIAL_READ_MAX_BYTES = 5 * 1024 * 1024;
/** 差分読み（offset指定）で1回のポーリングにつき offset から読む最大バイト数。超過分は次回ポーリングで続きを取得する。 */
const DEFAULT_INCREMENTAL_READ_MAX_BYTES = 5 * 1024 * 1024;
/** 一覧 preview 生成のためにファイル先頭から読むバイト数。 */
const DEFAULT_PREVIEW_SCAN_BYTES = 64 * 1024;
/**
 * Claude Code が中断時に role=user のメッセージへ自動注入するテキスト全体（実データで確認、
 * バリアント: "[Request interrupted by user for tool use]" / "[Request interrupted by user]"）。
 * 完全一致で判定する（前方一致だと `[Request interrupted by user] とはどういう意味？` のような
 * このテキストで始まる実際のユーザー発言まで誤って中断扱いにしてしまうため）。
 */
const INTERRUPT_TEXT_PATTERN = /^\[Request interrupted by user( for tool use)?\]$/;

/**
 * Claude Code がローカルスラッシュコマンド実行時に role=user の文字列 content として書く3種の定型
 * レコード（実データで確認、Issue #338 followup）:
 *  1. `<local-command-caveat>Caveat: ...` — 破棄対象（isMeta: true が付くことが多いが、判定は本文
 *     のプレフィックスのみで行う）。
 *  2. `<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>...` —
 *     'command' エントリへ変換する。
 *  3. `<local-command-stdout>...`/`<local-command-stderr>...`（ANSI エスケープ入り） — 直前の
 *     'command' エントリへマージする。隣接しない単独の stdout/stderr は commandName 無しの単独
 *     'command' エントリとして扱う。
 */
const LOCAL_COMMAND_CAVEAT_PREFIX = '<local-command-caveat>';
const COMMAND_NAME_PATTERN = /^<command-name>([^<]*)<\/command-name>[\s\S]*?<command-args>([^<]*)<\/command-args>\s*$/;
const LOCAL_COMMAND_STDOUT_PATTERN = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>\s*$/;
const LOCAL_COMMAND_STDERR_PATTERN = /^<local-command-stderr>([\s\S]*)<\/local-command-stderr>\s*$/;
/** SGR エスケープ（例: `\x1b[1m...\x1b[22m`）を除去する。local-command-stdout/stderr の装飾用。 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

export interface ClaudeTranscriptSourceOptions {
  /** 初回読みで末尾から遡って読む最大バイト数（テスト用に上書き可能）。既定値は DEFAULT_INITIAL_READ_MAX_BYTES。 */
  initialReadMaxBytes?: number;
  /** 差分読みで1回に読む最大バイト数（テスト用に上書き可能）。既定値は DEFAULT_INCREMENTAL_READ_MAX_BYTES。 */
  incrementalReadMaxBytes?: number;
  /** 一覧 preview 生成のためにファイル先頭から読むバイト数（テスト用に上書き可能）。既定値は DEFAULT_PREVIEW_SCAN_BYTES。 */
  previewScanBytes?: number;
}

// ─── Helpers ───

function resolveProjectsDir(baseDir?: string): string {
  return baseDir ?? path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
}

/** projects 直下の各プロジェクトディレクトリ直下（maxdepth 1）の *.jsonl のみを列挙する。subagents/ 等の子ディレクトリは含めない。 */
function listSessionFiles(projectsDir: string): { file: string; projectDir: string }[] {
  let projectEntries: fs.Dirent[];
  try {
    projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: { file: string; projectDir: string }[] = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = path.join(projectsDir, projectEntry.name);
    let fileEntries: fs.Dirent[];
    try {
      fileEntries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;
      results.push({ file: path.join(projectPath, fileEntry.name), projectDir: projectEntry.name });
    }
  }
  return results;
}

function extractPreviewText(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        const trimmed = block.text.trim();
        if (trimmed.length > 0) return trimmed;
      }
    }
  }
  return null;
}

interface SessionScanResult {
  preview: string;
  cwd: string | null;
}

/** 一覧表示用に、ファイル先頭 previewScanBytes 分だけを走査して preview テキストと cwd を拾う。 */
function scanSessionMeta(file: string, previewScanBytes: number): SessionScanResult {
  let content: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      content = readChunk(fd, size, 0, previewScanBytes).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { preview: '', cwd: null };
  }

  let preview = '';
  let cwd: string | null = null;
  const lines = content.split('\n');
  for (let i = 0; i < Math.min(lines.length, PREVIEW_SCAN_LINES); i++) {
    const line = lines[i];
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;

    if (cwd === null && typeof record.cwd === 'string' && record.cwd.length > 0) {
      cwd = record.cwd;
    }

    if (!preview && record.type === 'user') {
      const message = record.message;
      if (isRecord(message)) {
        const previewText = extractPreviewText(message.content);
        if (previewText) preview = previewText.slice(0, PREVIEW_LENGTH);
      }
    }

    if (preview && cwd !== null) break;
  }
  return { preview, cwd };
}

/** ファイル先頭行の record.timestamp（ISO文字列）を epoch ms に変換する。読めなければ null。 */
function readFirstLineTimestampMs(file: string): number | null {
  let content: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      content = readChunk(fd, fs.fstatSync(fd).size, 0, 4096).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const firstLine = content.split('\n')[0];
  if (!firstLine) return null;
  let record: unknown;
  try {
    record = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (!isRecord(record) || typeof record.timestamp !== 'string') return null;
  const ms = Date.parse(record.timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/** tool_result の content（文字列 or ブロック配列）を表示用テキストに変換する。 */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else {
        parts.push(JSON.stringify(block) ?? '');
      }
    }
    return parts.join('\n');
  }
  return JSON.stringify(content) ?? '';
}

/**
 * Claude Code の JSONL では tool_result は role=user のメッセージとして記録される。
 * blocks が tool_result のみ（text を1つも含まない）の user エントリは 'tool' として
 * 再分類し、フロントで人間のプロンプトと混同されないようにする。
 */
function normalizeEntryType(rawType: unknown, blocks: TranscriptBlock[]): TranscriptEntryType {
  if (rawType === 'user') {
    const isToolResultOnly = blocks.every((block) => block.kind === 'tool_result');
    return isToolResultOnly ? 'tool' : 'user';
  }
  if (rawType === 'assistant' || rawType === 'system') return rawType;
  return 'other';
}

/** message.content の各ブロックを TranscriptBlock に変換する。未知の type はスキップする。 */
function normalizeBlocks(content: unknown): TranscriptBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: TranscriptBlock[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    switch (raw.type) {
      case 'text': {
        if (typeof raw.text === 'string') blocks.push({ kind: 'text', text: raw.text });
        break;
      }
      case 'thinking': {
        if (typeof raw.thinking === 'string') blocks.push({ kind: 'thinking', text: raw.thinking });
        break;
      }
      case 'tool_use': {
        if (typeof raw.name === 'string') {
          const serialized = JSON.stringify(raw.input ?? {});
          const { text, truncated } = truncateText(serialized, TOOL_USE_INPUT_LIMIT);
          blocks.push({ kind: 'tool_use', name: raw.name, input: text, truncated });
        }
        break;
      }
      case 'tool_result': {
        const rawText = stringifyToolResultContent(raw.content);
        const { text, truncated } = truncateText(rawText, TOOL_RESULT_TEXT_LIMIT);
        const block: TranscriptBlock = { kind: 'tool_result', text, truncated };
        if (typeof raw.is_error === 'boolean') block.isError = raw.is_error;
        blocks.push(block);
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

/**
 * user エントリが中断マーカー（INTERRUPT_TEXT_PATTERN に完全一致するテキスト1ブロックのみ）かどうかを
 * 判定する。該当する場合、呼び出し側は通常の 'user' 型ではなく 'interrupted' 型として扱う（フロントで
 * ユーザー発話バブルとして誤表示させず、専用の終端行として描画するため）。
 */
function isInterruptMarkerEntry(rawType: unknown, blocks: TranscriptBlock[]): boolean {
  if (rawType !== 'user') return false;
  return blocks.length === 1 && blocks[0].kind === 'text' && INTERRUPT_TEXT_PATTERN.test(blocks[0].text);
}

/** 生の JSONL 行1件を TranscriptEntry に正規化する。スキップ対象は null を返す。 */
function normalizeEntry(record: unknown): TranscriptEntry | null {
  if (!isRecord(record)) return null;
  if (record.isSidechain === true) return null;
  if (record.type === 'summary') return null;

  const message = record.message;
  if (!isRecord(message)) return null;
  if (typeof record.uuid !== 'string') return null;

  const blocks = normalizeBlocks(message.content);
  if (blocks.length === 0) return null;

  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;

  if (isInterruptMarkerEntry(record.type, blocks)) {
    return { uuid: record.uuid, type: 'interrupted', timestamp, blocks: [] };
  }

  const entryType = normalizeEntryType(record.type, blocks);
  const model = entryType === 'assistant' && typeof message.model === 'string' ? message.model : undefined;

  return {
    uuid: record.uuid,
    type: entryType,
    timestamp,
    blocks,
    ...(model !== undefined ? { model } : {}),
  };
}

function stripAnsiEscapes(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '');
}

/** args が空でなければ "name args"、空なら name のみを返す。 */
function buildCommandName(name: string, args: string): string {
  const trimmedArgs = args.trim();
  return trimmedArgs.length > 0 ? `${name} ${trimmedArgs}` : name;
}

/**
 * role=user の3種のローカルコマンド定型レコード（caveat/command-name/stdout・stderr）を判定・変換する。
 * 該当しない（通常のユーザー発話・tool_result 等）場合は handled: false を返し、呼び出し側は既存の
 * normalizeEntry にフォールバックする。pendingCommand は直前に返した commandName 付き 'command'
 * エントリへの参照（直後の stdout/stderr をマージする対象）。
 */
function tryHandleLocalCommandRecord(
  record: Record<string, unknown>,
  pendingCommand: TranscriptEntry | null,
): { handled: true; entry: TranscriptEntry | null; nextPending: TranscriptEntry | null } | { handled: false } {
  if (record.type !== 'user') return { handled: false };
  if (record.isSidechain === true) return { handled: false };
  if (typeof record.uuid !== 'string') return { handled: false };
  const message = record.message;
  if (!isRecord(message) || typeof message.content !== 'string') return { handled: false };
  const content = message.content;
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;

  if (content.startsWith(LOCAL_COMMAND_CAVEAT_PREFIX)) {
    return { handled: true, entry: null, nextPending: null };
  }

  const nameMatch = COMMAND_NAME_PATTERN.exec(content);
  if (nameMatch) {
    const entry: TranscriptEntry = {
      uuid: record.uuid,
      type: 'command',
      timestamp,
      commandName: buildCommandName(nameMatch[1], nameMatch[2]),
      blocks: [],
    };
    return { handled: true, entry, nextPending: entry };
  }

  const outputMatch = LOCAL_COMMAND_STDOUT_PATTERN.exec(content) ?? LOCAL_COMMAND_STDERR_PATTERN.exec(content);
  if (outputMatch) {
    const text = stripAnsiEscapes(outputMatch[1]);
    if (pendingCommand) {
      if (text.length > 0) pendingCommand.blocks.push({ kind: 'text', text });
      return { handled: true, entry: null, nextPending: null };
    }
    const entry: TranscriptEntry = {
      uuid: record.uuid,
      type: 'command',
      timestamp,
      blocks: text.length > 0 ? [{ kind: 'text', text }] : [],
    };
    return { handled: true, entry, nextPending: null };
  }

  return { handled: false };
}

/**
 * 1回の読み取りウィンドウ（readSession/readSessionBefore/getSessionTailState の1呼び出し）専用の
 * parseLine を作る。pendingCommand（直前の commandName 付き 'command' エントリ）をクロージャに
 * 保持し、直後の stdout/stderr レコードをそこへマージする（ウィンドウをまたいだ状態保持はしない —
 * ポーリング境界をまたぐ稀なケースは commandName 無しの単独エントリとして表示されるだけで安全）。
 */
function buildParseLine(): (line: string) => TranscriptEntry | null {
  let pendingCommand: TranscriptEntry | null = null;
  return (line: string): TranscriptEntry | null => {
    if (!line) return null;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isRecord(record)) return null;

    const commandResult = tryHandleLocalCommandRecord(record, pendingCommand);
    if (commandResult.handled) {
      pendingCommand = commandResult.nextPending;
      return commandResult.entry;
    }
    pendingCommand = null;
    return normalizeEntry(record);
  };
}

// ─── Source ───

export class ClaudeTranscriptSource implements TranscriptSource {
  readonly agentType = 'claude';

  private readonly initialReadMaxBytes: number;
  private readonly incrementalReadMaxBytes: number;
  private readonly previewScanBytes: number;

  constructor(
    private readonly projectsDirOverride?: string,
    options: ClaudeTranscriptSourceOptions = {},
  ) {
    this.initialReadMaxBytes = options.initialReadMaxBytes ?? DEFAULT_INITIAL_READ_MAX_BYTES;
    this.incrementalReadMaxBytes = options.incrementalReadMaxBytes ?? DEFAULT_INCREMENTAL_READ_MAX_BYTES;
    this.previewScanBytes = options.previewScanBytes ?? DEFAULT_PREVIEW_SCAN_BYTES;
  }

  /**
   * sessionId → ファイルパスのキャッシュ（インスタンス寿命内で保持）。CodexTranscriptSource と同じ
   * パターン: getActivityStatus 等が getSessionMtimeMs → getSessionTailState のように findSessionFile を
   * 連続呼び出しするケースで、全プロジェクト配下の再帰走査を毎回繰り返さないようにする。キャッシュ
   * ヒット時は fs.existsSync でファイルの生存だけ確認して使い回し、消えていた場合と新規セッション
   * （キャッシュミス）の場合のみ listSessionFiles() で再走査する。
   */
  private readonly sessionFileCache = new Map<string, string>();

  private projectsDir(): string {
    return resolveProjectsDir(this.projectsDirOverride);
  }

  private warmSessionFileCache(files: { file: string; projectDir: string }[]): void {
    for (const { file } of files) {
      this.sessionFileCache.set(path.basename(file, '.jsonl'), file);
    }
  }

  listSessions(limit = 50): SessionSummary[] {
    const files = listSessionFiles(this.projectsDir());
    this.warmSessionFileCache(files);

    const stated: { file: string; projectDir: string; sessionId: string; stat: fs.Stats }[] = [];
    for (const { file, projectDir } of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      stated.push({ file, projectDir, sessionId: path.basename(file, '.jsonl'), stat });
    }

    // mtime 降順ソート + limit 適用を先に行い、limit 件だけ preview を生成する（全件 preview 生成を避ける）。
    stated.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const limited = stated.slice(0, limit);

    return limited.map(({ file, projectDir, sessionId, stat }) => {
      const { preview, cwd } = scanSessionMeta(file, this.previewScanBytes);
      return {
        sessionId,
        agentType: this.agentType,
        projectDir,
        cwd,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        preview,
      };
    });
  }

  private findSessionFile(sessionId: string): string | null {
    if (!SESSION_ID_PATTERN.test(sessionId)) return null;

    const cached = this.sessionFileCache.get(sessionId);
    if (cached !== undefined) {
      if (fs.existsSync(cached)) return cached;
      this.sessionFileCache.delete(sessionId);
    }

    const files = listSessionFiles(this.projectsDir());
    this.warmSessionFileCache(files);
    const match = files.find(({ file }) => path.basename(file, '.jsonl') === sessionId);
    return match ? match.file : null;
  }

  /**
   * セッションの cwd（JSONL 行の cwd フィールド）を取得する。セッションが存在しない
   * （不正な sessionId またはファイル未検出）場合は null を返す。cwd を記録した行が
   * 見つからない場合は `{ cwd: null }` を返す（セッション自体は存在する）。
   */
  getSessionCwd(sessionId: string): { cwd: string | null } | null {
    const file = this.findSessionFile(sessionId);
    if (!file) return null;
    const { cwd } = scanSessionMeta(file, this.previewScanBytes);
    return { cwd };
  }

  getSessionMtimeMs(sessionId: string): number | null {
    const file = this.findSessionFile(sessionId);
    if (!file) return null;
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * 作成時刻はまず stat の birthtime を試す。一部のファイルシステム（非対応 fs 等）では
   * birthtimeMs が 0 のまま返る（Node の既知挙動）ため、その場合は先頭行の timestamp
   * フィールド（record.timestamp、readSession 等と同じ形式）にフォールバックする。
   */
  getSessionCreatedMs(sessionId: string): number | null {
    const file = this.findSessionFile(sessionId);
    if (!file) return null;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    if (stat.birthtimeMs > 0) return stat.birthtimeMs;
    return readFirstLineTimestampMs(file);
  }

  readSession(sessionId: string, offset?: number): ReadSessionResult | null {
    const file = this.findSessionFile(sessionId);
    if (!file) return null;

    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return null;
    }

    try {
      const size = fs.fstatSync(fd).size;
      const parseLine = buildParseLine();
      return offset === undefined
        ? readInitialWindow(fd, size, this.initialReadMaxBytes, parseLine, TAIL_ENTRY_LIMIT)
        : readIncrementalWindow(fd, size, offset, this.incrementalReadMaxBytes, parseLine);
    } finally {
      fs.closeSync(fd);
    }
  }

  readSessionBefore(sessionId: string, before: number): ReadSessionBeforeResult | null {
    const file = this.findSessionFile(sessionId);
    if (!file) return null;

    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return null;
    }

    try {
      const size = fs.fstatSync(fd).size;
      return readBeforeWindow(fd, size, before, this.incrementalReadMaxBytes, buildParseLine());
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 末尾 TAIL_STATE_SCAN_BYTES 分だけを読み、末尾から遡って最初にパース可能な行を分類する。 */
  async getSessionTailState(sessionId: string): Promise<'in_progress' | 'terminal' | 'unknown'> {
    const file = this.findSessionFile(sessionId);
    if (!file) return 'unknown';

    let content: string;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(size - TAIL_STATE_SCAN_BYTES, 0);
        content = readChunk(fd, size, start, size - start).toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return 'unknown';
    }

    const parseLine = buildParseLine();
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseLine(lines[i]);
      if (entry) return classifyTailEntry(entry);
    }
    return 'unknown';
  }
}
