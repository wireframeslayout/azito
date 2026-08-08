import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Types ───

export interface SessionSummary {
  sessionId: string;
  projectDir: string;
  mtimeMs: number;
  sizeBytes: number;
  preview: string;
}

export type TranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; name: string; input: string; truncated: boolean }
  | { kind: 'tool_result'; text: string; truncated: boolean; isError?: boolean };

export type TranscriptEntryType = 'user' | 'assistant' | 'system' | 'other';

export interface TranscriptEntry {
  uuid: string;
  type: TranscriptEntryType;
  timestamp: string | null;
  blocks: TranscriptBlock[];
}

export interface ReadSessionResult {
  entries: TranscriptEntry[];
  nextOffset: number;
  truncated: boolean;
}

// ─── Constants ───

const TOOL_USE_INPUT_LIMIT = 2000;
const TOOL_RESULT_TEXT_LIMIT = 4000;
const PREVIEW_LENGTH = 120;
const PREVIEW_SCAN_LINES = 20;
const TAIL_ENTRY_LIMIT = 500;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function buildPreview(file: string): string {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }

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
    if (!isRecord(record) || record.type !== 'user') continue;
    const message = record.message;
    if (!isRecord(message)) continue;
    const previewText = extractPreviewText(message.content);
    if (previewText) return previewText.slice(0, PREVIEW_LENGTH);
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
        parts.push(JSON.stringify(block));
      }
    }
    return parts.join('\n');
  }
  return JSON.stringify(content);
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

function normalizeEntryType(rawType: unknown): TranscriptEntryType {
  if (rawType === 'user' || rawType === 'assistant' || rawType === 'system') return rawType;
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
    type: normalizeEntryType(record.type),
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

// ─── Service ───

export class TranscriptService {
  constructor(private readonly projectsDirOverride?: string) {}

  private projectsDir(): string {
    return resolveProjectsDir(this.projectsDirOverride);
  }

  listSessions(limit = 50): SessionSummary[] {
    const files = listSessionFiles(this.projectsDir());

    const summaries: SessionSummary[] = [];
    for (const { file, projectDir } of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const sessionId = path.basename(file, '.jsonl');
      summaries.push({
        sessionId,
        projectDir,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        preview: buildPreview(file),
      });
    }

    summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return summaries.slice(0, limit);
  }

  private findSessionFile(sessionId: string): string | null {
    if (!SESSION_ID_PATTERN.test(sessionId)) return null;
    const files = listSessionFiles(this.projectsDir());
    const match = files.find(({ file }) => path.basename(file, '.jsonl') === sessionId);
    return match ? match.file : null;
  }

  readSession(sessionId: string, offset?: number): ReadSessionResult | null {
    const file = this.findSessionFile(sessionId);
    if (!file) return null;

    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return null;
    }

    if (offset === undefined) {
      const lines = buf.toString('utf-8').split('\n');
      const entries: TranscriptEntry[] = [];
      for (const line of lines) {
        const entry = parseLine(line);
        if (entry) entries.push(entry);
      }
      return {
        entries: entries.slice(-TAIL_ENTRY_LIMIT),
        nextOffset: buf.length,
        truncated: true,
      };
    }

    const start = Math.min(Math.max(offset, 0), buf.length);
    const chunk = buf.subarray(start);

    let lastNewline = -1;
    for (let i = chunk.length - 1; i >= 0; i--) {
      if (chunk[i] === 0x0a) {
        lastNewline = i;
        break;
      }
    }

    if (lastNewline === -1) {
      return { entries: [], nextOffset: start, truncated: false };
    }

    const consumed = chunk.subarray(0, lastNewline).toString('utf-8');
    const entries: TranscriptEntry[] = [];
    for (const line of consumed.split('\n')) {
      const entry = parseLine(line);
      if (entry) entries.push(entry);
    }

    return {
      entries,
      nextOffset: start + lastNewline + 1,
      truncated: false,
    };
  }
}
