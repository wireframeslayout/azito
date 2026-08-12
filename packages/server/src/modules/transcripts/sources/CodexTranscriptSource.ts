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

// ─── Codex CLI (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) 用ソース ───
//
// 1行1JSON `{timestamp, type, payload}`。実データで確認した type:
//   session_meta（payload.id=セッションUUID, payload.cwd） / turn_context / event_msg
//   （user_message/agent_message/task_started/task_complete/token_count 等、response_item と
//   内容が重複するため無視。ただし payload.type === 'turn_aborted'（ユーザーによる中断、
//   payload.reason: 'interrupted'）のみ例外的に 'interrupted' エントリへ変換する — 対応する
//   response_item が書かれないため、これを見逃すと中断後も最後の可視エントリがツール結果のままになり、
//   フロントの liveStatus が誤って「応答待ち」を表示し続けてしまう） / response_item（payload.type: message/reasoning/function_call/
//   function_call_output/custom_tool_call/custom_tool_call_output のみを変換。custom_tool_call は
//   apply_patch/exec 等の freeform ツール呼び出しで、input は文字列（生パッチ/スクリプト本文）。
//   対応する custom_tool_call_output.output は文字列・{type:'input_text',text}形の配列・null のいずれも
//   実データで確認（配列は text を連結）。local_shell_call 等のその他 type は実データ未確認のため未対応でスキップ。

// ─── ID Format ───
//
// function_call/function_call_output・custom_tool_call/custom_tool_call_output は呼び出しと結果が
// 同じ call_id を共有するため、uuid は `${callId}:call` / `${callId}:output` で一意化する
// （同一 call_id をそのまま uuid にすると React の key が重複する）。

// ─── Constants ───

const PREVIEW_LENGTH = 120;
/** session_meta は先頭行、最初のユーザー発話は developer/environment_context に続く数行後に来るため、
 * Claude（20行）より広めに走査する。 */
const PREVIEW_SCAN_LINES = 200;
const TAIL_ENTRY_LIMIT = 500;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE_PATTERN = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/**
 * ファイル名先頭の作成時刻部分（`rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`）。実データ確認:
 * この時刻はファイル作成時のローカル時刻（system timezone）で、UTC ではない
 * （コロンがファイル名に使えないため `-` に置換されているのみで、タイムゾーン情報は無い）。
 * そのため Date.UTC ではなく `new Date(y, m-1, d, h, mi, s)`（ローカル時刻として解釈）で
 * epoch ms に変換する必要がある — プロセス起動時刻（同一マシンのローカル時刻基準）と比較するため。
 */
const SESSION_FILE_TIMESTAMP_PATTERN =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** ファイル名から作成時刻（epoch ms）を取り出す。パターン不一致・不正な日時なら null。 */
function parseCreatedMsFromFilename(file: string): number | null {
  const match = SESSION_FILE_TIMESTAMP_PATTERN.exec(path.basename(file));
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const ms = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
  return Number.isNaN(ms) ? null : ms;
}
/**
 * Codex CLI が role=user の message に自動注入する定型テキストのプレフィックス（実データで確認）。
 * `<environment_context>`（毎ターン注入のcwd/日時情報）、`<recommended_plugins>`（未インストールプラグイン一覧）、
 * `<turn_aborted>`（中断通知）、`# AGENTS.md instructions`（AGENTS.md の自動読み込み）。
 * これらは実際のユーザー入力ではないため、該当する content ブロックを除外する（フォールバック合成ではなく除外）。
 */
const SYNTHETIC_USER_TEXT_PREFIXES = ['<environment_context>', '<recommended_plugins>', '<turn_aborted>', '# AGENTS.md instructions'];

function isSyntheticUserText(text: string): boolean {
  const trimmed = text.trim();
  return SYNTHETIC_USER_TEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}
const DEFAULT_INITIAL_READ_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_INCREMENTAL_READ_MAX_BYTES = 5 * 1024 * 1024;
/**
 * Codex は session_meta の base_instructions（システムプロンプト全文、~20KB）や developer/user の
 * skills・plugins・AGENTS.md 注入ブロックを毎セッション冒頭にインラインで記録するため、実データでは
 * 最初の実ユーザー発話に到達するまでに 200KB を超えることがある（Claude の 64KB では足りない）。
 */
const DEFAULT_PREVIEW_SCAN_BYTES = 512 * 1024;

export interface CodexTranscriptSourceOptions {
  initialReadMaxBytes?: number;
  incrementalReadMaxBytes?: number;
  previewScanBytes?: number;
}

// ─── File enumeration ───

function resolveSessionsDir(baseDir?: string): string {
  return baseDir ?? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
}

/** sessions/YYYY/MM/DD/rollout-*.jsonl を列挙する（日付3階層固定）。 */
function listSessionFiles(sessionsDir: string): { file: string; sessionId: string }[] {
  const results: { file: string; sessionId: string }[] = [];
  let years: fs.Dirent[];
  try {
    years = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const year of years) {
    if (!year.isDirectory()) continue;
    const yearPath = path.join(sessionsDir, year.name);
    let months: fs.Dirent[];
    try {
      months = fs.readdirSync(yearPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const month of months) {
      if (!month.isDirectory()) continue;
      const monthPath = path.join(yearPath, month.name);
      let days: fs.Dirent[];
      try {
        days = fs.readdirSync(monthPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const day of days) {
        if (!day.isDirectory()) continue;
        const dayPath = path.join(monthPath, day.name);
        let files: fs.Dirent[];
        try {
          files = fs.readdirSync(dayPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.isFile()) continue;
          const match = SESSION_FILE_PATTERN.exec(file.name);
          if (!match) continue;
          results.push({ file: path.join(dayPath, file.name), sessionId: match[1] });
        }
      }
    }
  }
  return results;
}

// ─── Preview / cwd scan ───

interface SessionScanResult {
  preview: string;
  cwd: string | null;
}

function extractUserPreviewText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (isRecord(item) && item.type === 'input_text' && typeof item.text === 'string') {
      const trimmed = item.text.trim();
      if (trimmed.length > 0 && !isSyntheticUserText(trimmed)) {
        return trimmed;
      }
    }
  }
  return null;
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

    if (cwd === null && record.type === 'session_meta' && isRecord(record.payload) && typeof record.payload.cwd === 'string') {
      cwd = record.payload.cwd;
    }

    if (
      !preview &&
      record.type === 'response_item' &&
      isRecord(record.payload) &&
      record.payload.type === 'message' &&
      record.payload.role === 'user'
    ) {
      const text = extractUserPreviewText(record.payload.content);
      if (text) preview = text.slice(0, PREVIEW_LENGTH);
    }

    if (preview && cwd !== null) break;
  }
  return { preview, cwd };
}

// ─── response_item → TranscriptEntry normalization ───

/**
 * message.content の各要素を text ブロックへ変換する。Codex は1つの user message の中に
 * 自動注入テキスト（recommended_plugins/AGENTS.md/environment_context）と実際のユーザー入力とを
 * 同じ content 配列に混在させて記録することがあるため、要素単位で合成テキストを除外する。
 */
function normalizeMessageBlocks(content: unknown): TranscriptBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: TranscriptBlock[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if ((item.type === 'input_text' || item.type === 'output_text') && typeof item.text === 'string' && item.text.length > 0) {
      if (isSyntheticUserText(item.text)) continue;
      blocks.push({ kind: 'text', text: item.text });
    }
  }
  return blocks;
}

function normalizeReasoningBlocks(summary: unknown): TranscriptBlock[] {
  if (!Array.isArray(summary)) return [];
  const blocks: TranscriptBlock[] = [];
  for (const item of summary) {
    if (isRecord(item) && item.type === 'summary_text' && typeof item.text === 'string' && item.text.length > 0) {
      blocks.push({ kind: 'thinking', text: item.text });
    }
  }
  return blocks;
}

/** role=developer はシステムプロンプト注入（permission/collaboration instructions）で毎ターン繰り返されるため除外する。 */
function normalizeMessageEntryType(role: unknown): TranscriptEntryType | null {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  return null;
}

/**
 * custom_tool_call_output.output は文字列（生テキスト）・配列（{type:'input_text', text} 等の
 * ブロック列）・null のいずれもあり得る（実データで確認）。配列は text プロパティを持つ要素を
 * 連結し、それ以外（null 等）は既存の function_call_output と同じ JSON.stringify フォールバックに揃える。
 */
function normalizeToolOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.text === 'string')
      .map((item) => item.text as string)
      .join('\n');
  }
  return JSON.stringify(output ?? '');
}

/**
 * call_id を持つ response_item（function_call/function_call_output, custom_tool_call/
 * custom_tool_call_output）の uuid を生成する。呼び出しと結果は同じ call_id を共有するため、
 * `:call` / `:output` サフィックスで一意化する（React key 重複防止）。
 */
function callUuid(callId: string, direction: 'call' | 'output'): string {
  return `${callId}:${direction}`;
}

function normalizeResponseItem(record: Record<string, unknown>, callId: string | null, fallbackUuid: string): TranscriptEntry | null {
  const payload = record.payload;
  if (!isRecord(payload)) return null;
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;

  switch (payload.type) {
    case 'message': {
      const entryType = normalizeMessageEntryType(payload.role);
      if (entryType === null) return null;
      const blocks = normalizeMessageBlocks(payload.content);
      if (blocks.length === 0) return null;
      return { uuid: fallbackUuid, type: entryType, timestamp, blocks };
    }
    case 'reasoning': {
      const blocks = normalizeReasoningBlocks(payload.summary);
      if (blocks.length === 0) return null;
      return { uuid: fallbackUuid, type: 'assistant', timestamp, blocks };
    }
    case 'function_call': {
      if (typeof payload.name !== 'string') return null;
      const argsText = typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments ?? {});
      const { text, truncated } = truncateText(argsText, TOOL_USE_INPUT_LIMIT);
      const uuid = callId ? callUuid(callId, 'call') : fallbackUuid;
      return { uuid, type: 'tool', timestamp, blocks: [{ kind: 'tool_use', name: payload.name, input: text, truncated }] };
    }
    case 'function_call_output': {
      const rawOutput = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
      const { text, truncated } = truncateText(rawOutput, TOOL_RESULT_TEXT_LIMIT);
      const uuid = callId ? callUuid(callId, 'output') : fallbackUuid;
      return { uuid, type: 'tool', timestamp, blocks: [{ kind: 'tool_result', text, truncated }] };
    }
    case 'custom_tool_call': {
      // freeform ツール（apply_patch/exec 等）。input は実データ上つねに文字列（生スクリプト/パッチ本文）。
      if (typeof payload.name !== 'string') return null;
      const argsText = typeof payload.input === 'string' ? payload.input : JSON.stringify(payload.input ?? {});
      const { text, truncated } = truncateText(argsText, TOOL_USE_INPUT_LIMIT);
      const uuid = callId ? callUuid(callId, 'call') : fallbackUuid;
      return { uuid, type: 'tool', timestamp, blocks: [{ kind: 'tool_use', name: payload.name, input: text, truncated }] };
    }
    case 'custom_tool_call_output': {
      const rawOutput = normalizeToolOutputText(payload.output);
      const { text, truncated } = truncateText(rawOutput, TOOL_RESULT_TEXT_LIMIT);
      const uuid = callId ? callUuid(callId, 'output') : fallbackUuid;
      return { uuid, type: 'tool', timestamp, blocks: [{ kind: 'tool_result', text, truncated }] };
    }
    default:
      // local_shell_call 等、実データで未確認の type は変換不能としてスキップする（フォールバック合成禁止）
      return null;
  }
}

/**
 * event_msg 行のうち payload.type === 'turn_aborted'（ユーザーによる中断）のみを 'interrupted'
 * エントリへ変換する。それ以外の event_msg は response_item と重複するため引き続き無視（null）。
 * uuid は対応する call_id を持たないため、呼び出し側の行インデックス由来の fallbackUuid をそのまま使う。
 */
function normalizeEventMsg(record: Record<string, unknown>, fallbackUuid: string): TranscriptEntry | null {
  const payload = record.payload;
  if (!isRecord(payload) || payload.type !== 'turn_aborted') return null;
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
  return { uuid: fallbackUuid, type: 'interrupted', timestamp, blocks: [] };
}

/**
 * 1行 → TranscriptEntry のパーサを作る。call_id を持つ function_call/function_call_output・
 * custom_tool_call/custom_tool_call_output は、それを uuid のベースに使う（呼び出しと結果の
 * 対応が視覚的にも安定する）。呼び出しと結果は同じ call_id を共有するため normalizeResponseItem
 * 側で `:call`/`:output` サフィックスを付けて一意化する。id を持たない message/reasoning は、
 * この読み取りウィンドウ内の行インデックスから安定生成する（windowKey は offset 単位で一意なため、
 * ウィンドウをまたいだ衝突はない）。
 */
function buildParseLine(windowKey: string): (line: string) => TranscriptEntry | null {
  let index = 0;
  return (line: string): TranscriptEntry | null => {
    const currentIndex = index;
    index += 1;
    if (!line) return null;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isRecord(record)) return null;
    const fallbackUuid = `${windowKey}-${currentIndex}`;

    if (record.type === 'event_msg') return normalizeEventMsg(record, fallbackUuid);
    if (record.type !== 'response_item') return null;

    const payload = record.payload;
    const callId = isRecord(payload) && typeof payload.call_id === 'string' ? payload.call_id : null;
    return normalizeResponseItem(record, callId, fallbackUuid);
  };
}

// ─── Source ───

export class CodexTranscriptSource implements TranscriptSource {
  readonly agentType = 'codex';

  private readonly initialReadMaxBytes: number;
  private readonly incrementalReadMaxBytes: number;
  private readonly previewScanBytes: number;

  constructor(
    private readonly sessionsDirOverride?: string,
    options: CodexTranscriptSourceOptions = {},
  ) {
    this.initialReadMaxBytes = options.initialReadMaxBytes ?? DEFAULT_INITIAL_READ_MAX_BYTES;
    this.incrementalReadMaxBytes = options.incrementalReadMaxBytes ?? DEFAULT_INCREMENTAL_READ_MAX_BYTES;
    this.previewScanBytes = options.previewScanBytes ?? DEFAULT_PREVIEW_SCAN_BYTES;
  }

  /**
   * sessionId → ファイルパスのキャッシュ（インスタンス寿命内で保持）。readSession は 2秒ポーリングで
   * 呼ばれるため、毎回 sessions 配下を再帰走査するとサーバー台数×セッション数に比例してコストが増える。
   * キャッシュヒット時は fs.existsSync でファイルの生存だけ確認して使い回す。消えていた場合と、
   * 新規セッション（キャッシュミス）の場合のみ scanSessionFiles() で再走査する。
   */
  private readonly sessionFileCache = new Map<string, string>();

  private sessionsDir(): string {
    return resolveSessionsDir(this.sessionsDirOverride);
  }

  /** テストから走査回数を spy できるよう、実際の再帰走査呼び出しをメソッドに切り出す。 */
  private scanSessionFiles(): { file: string; sessionId: string }[] {
    return listSessionFiles(this.sessionsDir());
  }

  private warmSessionFileCache(files: { file: string; sessionId: string }[]): void {
    for (const { sessionId, file } of files) {
      this.sessionFileCache.set(sessionId, file);
    }
  }

  listSessions(limit = 50): SessionSummary[] {
    const files = this.scanSessionFiles();
    this.warmSessionFileCache(files);

    const stated: { file: string; sessionId: string; stat: fs.Stats }[] = [];
    for (const { file, sessionId } of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      stated.push({ file, sessionId, stat });
    }

    stated.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const limited = stated.slice(0, limit);

    return limited.map(({ file, sessionId, stat }) => {
      const { preview, cwd } = scanSessionMeta(file, this.previewScanBytes);
      return {
        sessionId,
        agentType: this.agentType,
        // Claude の projectDir（プロジェクトディレクトリ名）相当の情報が Codex には無いため、cwd basename で代替する。
        projectDir: cwd ? path.basename(cwd) : sessionId,
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

    const files = this.scanSessionFiles();
    this.warmSessionFileCache(files);
    const match = files.find((f) => f.sessionId === sessionId);
    return match ? match.file : null;
  }

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

  getSessionCreatedMs(sessionId: string): number | null {
    const file = this.findSessionFile(sessionId);
    if (!file) return null;
    return parseCreatedMsFromFilename(file);
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
      const windowKey = offset === undefined ? 'i' : String(offset);
      const parseLine = buildParseLine(windowKey);
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
      const parseLine = buildParseLine(`b${before}`);
      return readBeforeWindow(fd, size, before, this.incrementalReadMaxBytes, parseLine);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * 末尾 TAIL_STATE_SCAN_BYTES 分だけを読み、末尾から遡って最初にパース可能な行を分類する。
   * buildParseLine と同じ変換（normalizeResponseItem/normalizeEventMsg）を使うため、'reasoning' は
   * Claude の thinking ブロックと同じ type:'assistant' 形に正規化され、classifyTailEntry が
   * エージェント非依存に扱える。
   */
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

    const parseLine = buildParseLine('tail');
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseLine(lines[i]);
      if (entry) return classifyTailEntry(entry);
    }
    return 'unknown';
  }
}
