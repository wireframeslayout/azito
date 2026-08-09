import fs from 'fs';
import path from 'path';
import os from 'os';
import { isRecord, truncateText, TOOL_USE_INPUT_LIMIT, TOOL_RESULT_TEXT_LIMIT } from './entryHelpers';
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

  return {
    uuid: record.uuid,
    type: normalizeEntryType(record.type, blocks),
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
    blocks,
  };
}

function parseLine(line: string): TranscriptEntry | null {
  if (!line) return null;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  return normalizeEntry(record);
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

  private projectsDir(): string {
    return resolveProjectsDir(this.projectsDirOverride);
  }

  listSessions(limit = 50): SessionSummary[] {
    const files = listSessionFiles(this.projectsDir());

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
    const files = listSessionFiles(this.projectsDir());
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
      return readBeforeWindow(fd, size, before, this.incrementalReadMaxBytes, parseLine);
    } finally {
      fs.closeSync(fd);
    }
  }
}
