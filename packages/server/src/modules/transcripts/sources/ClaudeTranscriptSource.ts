import fs from 'fs';
import path from 'path';
import os from 'os';
import { isRecord, truncateText, classifyTailEntry, parseEntryTimestampMs, TOOL_USE_INPUT_LIMIT, TOOL_RESULT_TEXT_LIMIT, TAIL_STATE_SCAN_BYTES } from './entryHelpers';
import { readChunk, readInitialWindow, readIncrementalWindow, readBeforeWindow } from './jsonlWindowReader';
import type {
  ReadSessionBeforeResult,
  ReadSessionResult,
  SessionSummary,
  SessionTailState,
  TranscriptBlock,
  TranscriptEntry,
  TranscriptEntryType,
  TranscriptInteraction,
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
 *  1. `<local-command-caveat>Caveat: ...` — 破棄対象。実レコードでは常に isMeta: true が付く
 *     （レビュー指摘 Minor 2: 本文プレフィックスのみで判定すると、ユーザーが本文冒頭にたまたま
 *     同じタグを書いた通常プロンプトまで黙って破棄してしまうため、isMeta === true を必須条件にする）。
 *  2. `<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>...` —
 *     'command' エントリへ変換する。content 全体がこの構造（command-name + command-message +
 *     command-args の3タグのみ）に完全一致する場合のみ command 化する（レビュー指摘 Minor 2:
 *     command-name/command-args の間に任意の文字列を許すと、たまたま似た構造を書いた通常発言まで
 *     command 扱いになり得るため、実レコードに必ず存在する command-message タグの完全一致を要求する）。
 *  3. `<local-command-stdout>...`/`<local-command-stderr>...`（ANSI エスケープ入り） — 直前の
 *     'command' エントリへマージする。隣接しない単独の stdout/stderr は、content 全体がそのタグ
 *     1つで完結する場合のみ commandName 無しの単独 'command' エントリとして扱う。
 *
 * これらの判定は完全一致（content 全体のアンカー一致）まで絞ってもなお、理論上はユーザーが厳密に
 * 同じテキストを入力すれば偽装できてしまう。ただし影響は表示レベル（そのメッセージが command 行の
 * 見た目で描画される・稼働判定が terminal に倒れる）に留まり、実行内容やデータには影響しない。
 */
const LOCAL_COMMAND_CAVEAT_PREFIX = '<local-command-caveat>';
const COMMAND_NAME_PATTERN =
  /^<command-name>([^<]*)<\/command-name>\s*<command-message>[^<]*<\/command-message>\s*<command-args>([^<]*)<\/command-args>\s*$/;
const LOCAL_COMMAND_STDOUT_PATTERN = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>\s*$/;
const LOCAL_COMMAND_STDERR_PATTERN = /^<local-command-stderr>([\s\S]*)<\/local-command-stderr>\s*$/;
/** SGR エスケープ（例: `\x1b[1m...\x1b[22m`）を除去する。local-command-stdout/stderr の装飾用。 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * AskUserQuestion（Claude Code 標準ツール）正規化（Issue #338 フェーズA）。実データで確認した構造:
 *  - tool_use（role=assistant）: `input: { questions: [{ question, header, multiSelect, options:
 *    [{ label, description }] }] }`
 *  - tool_result（role=user）: `message.content[0]` は要約文字列のみで、実際の回答値は同レコード
 *    直下の `toolUseResult.answers`（質問文字列 → 回答文字列。multiSelect は "A, B" のカンマ区切り
 *    文字列）に入る。ユーザーが選択肢を使わず自由記述（CLI の「Type something」）で答えた場合も
 *    同じ `answers` 形に入り、options のどのラベルとも一致しない文字列になる（実データで確認）。
 *    ユーザーが質問自体を拒否した場合（Esc 等）は `toolUseResult` がオブジェクトではなく文字列
 *    "User rejected tool use" になる — この場合は確定回答が無いので interaction 化しない（通常の
 *    'tool' エントリへフォールバックする）。
 */
const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

/**
 * セッション単位の askUserQuestionCache（tool_use id → questions）の上限件数（レビュー指摘 Minor 3c）。
 * 拒否・放棄された質問や後方ページング中に見つかった質問が無期限に残り続けないよう、挿入順で最も
 * 古いエントリを evict する（Map の挿入順イテレーションを利用した FIFO）。
 */
const ASK_USER_QUESTION_CACHE_MAX_ENTRIES = 32;

/**
 * 読み取り窓分断（初回窓の開始位置／サーバー再起動でのキャッシュ消失）で対応する tool_use がキャッシュに
 * 無い場合の救済スキャン範囲（レビュー指摘 Minor 2）。この範囲だけ before から遡って対応する tool_use を
 * 探す。見つからなければ従来どおり生 tool 行として表示する（それ以上は複雑化しない）。
 */
const ASK_USER_QUESTION_BACKWARD_SCAN_BYTES = 256 * 1024;

interface AskUserQuestionItem {
  question: string;
  multiSelect: boolean;
  options?: { label: string; description?: string }[];
}

/** tool_use の input を検証しつつ AskUserQuestionItem[] へ変換する。形が合わなければ null。 */
function parseAskUserQuestionInput(raw: unknown): AskUserQuestionItem[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.questions)) return null;
  const items: AskUserQuestionItem[] = [];
  for (const q of raw.questions) {
    if (!isRecord(q) || typeof q.question !== 'string') return null;
    let options: { label: string; description?: string }[] | undefined;
    if (Array.isArray(q.options)) {
      options = [];
      for (const o of q.options) {
        if (isRecord(o) && typeof o.label === 'string') {
          options.push({ label: o.label, description: typeof o.description === 'string' ? o.description : undefined });
        }
      }
    }
    items.push({ question: q.question, multiSelect: q.multiSelect === true, options });
  }
  return items.length > 0 ? items : null;
}

/**
 * フィールドの input 種別を決める。multiSelect は常に 'multiselect'。単一選択は、回答値が options の
 * いずれかのラベルと完全一致すれば 'select'、一致しなければ CLI の「Type something」自由記述回答と
 * みなし 'text' とする（実データで確認: 自由記述の回答も options とは無関係な文字列として answers に
 * 入るため、値の一致有無でしか判別できない）。
 */
function inferInteractionFieldInput(item: AskUserQuestionItem, answerValue: string | undefined): 'select' | 'multiselect' | 'text' {
  if (item.multiSelect) return 'multiselect';
  if (answerValue === undefined) return 'select';
  return item.options?.some((o) => o.label === answerValue) ? 'select' : 'text';
}

/**
 * キャッシュ済みの質問群 + 回答マップから TranscriptInteraction を組み立てる。answersByQuestion は
 * Map で受け取る（レビュー指摘 Minor 5: 質問文字列をキーにした素のオブジェクトのブラケットアクセスは
 * `__proto__`/`constructor` 等のプロトタイプ継承プロパティを誤って拾い得るため、own-property の保証が
 * ある Map を使う）。
 */
function buildInteraction(items: AskUserQuestionItem[], answersByQuestion: Map<string, string>): TranscriptInteraction {
  const fields: TranscriptInteraction['fields'] = [];
  const answers: NonNullable<TranscriptInteraction['answers']> = [];

  items.forEach((item, index) => {
    const id = `q${index}`;
    const answerValue = answersByQuestion.get(item.question);
    fields.push({
      id,
      label: item.question,
      input: inferInteractionFieldInput(item, answerValue),
      ...(item.options ? { options: item.options.map((o) => ({ value: o.label, label: o.label, description: o.description })) } : {}),
    });
    if (answerValue !== undefined) answers.push({ fieldId: id, value: answerValue });
  });

  return {
    kind: 'question',
    source: { origin: 'tool', name: ASK_USER_QUESTION_TOOL_NAME },
    fields,
    ...(answers.length > 0 ? { answers } : {}),
  };
}

/**
 * assistant レコードの content から AskUserQuestion の tool_use ブロックを取り除き、その質問群を
 * cache（tool_use id → questions）へ保存する。他の tool_use/text 等が同居していれば残りのブロックは
 * 通常どおり描画対象として残す（fallthrough）。AskUserQuestion のみのブロック列だった場合は content
 * が空配列になり、呼び出し元の normalizeBlocks/normalizeEntry が blocks.length===0 で null を返す
 * （＝このレコード自体は表示されない。対応する tool_result の位置で interaction エントリとして emit
 * されるため、置換になる）。
 *
 * allowCacheWrite が false（readSessionBefore の後方ページング中）のときはキャッシュへ書き込まない
 * （レビュー指摘 Minor 3a）— 後方ページングは既に解決済みの履歴を遡って表示するための読み取りであり、
 * ここで見つかった tool_use を通常の chronological キャッシュへ混ぜると寿命管理が破綻するため。
 * ブロック自体は allowCacheWrite に関わらず常に除去する（表示上、生の tool_use は出さない方針は不変）。
 */
function extractAskUserQuestionToolUse(content: unknown, cache: Map<string, AskUserQuestionItem[]>, allowCacheWrite: boolean): unknown {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const filtered: unknown[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'tool_use' && block.name === ASK_USER_QUESTION_TOOL_NAME && typeof block.id === 'string') {
      const items = parseAskUserQuestionInput(block.input);
      if (items) {
        if (allowCacheWrite) {
          cache.set(block.id, items);
          // セッション単位の上限を超えたら挿入順で最も古いエントリを evict する（Minor 3c）。
          if (cache.size > ASK_USER_QUESTION_CACHE_MAX_ENTRIES) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey !== undefined) cache.delete(oldestKey);
          }
        }
        changed = true;
        continue;
      }
    }
    filtered.push(block);
  }
  return changed ? filtered : content;
}

/**
 * role=user の tool_result レコードが、cache 済みの AskUserQuestion への確定回答であれば
 * 'interaction' エントリを組み立てて返す。該当しない（AskUserQuestion 以外の tool_result、対応する
 * tool_use が見つからない＝読み取りウィンドウ外、質問が拒否され toolUseResult がオブジェクトでない
 * 等）場合は null を返し、呼び出し側は通常の normalizeEntry にフォールバックする。
 * content が単一の tool_result ブロックのみで構成されるレコードのみを対象とする（実データで確認した
 * 形。他ブロックと混在するケースは実データで未確認のため対象外とし、通常の 'tool' エントリのまま
 * 表示する）。
 */
/**
 * cache に無い tool_use_id について、直前 ASK_USER_QUESTION_BACKWARD_SCAN_BYTES バイトだけ readBeforeWindow
 * で後方スキャンし、対応する AskUserQuestion の tool_use を探す（レビュー指摘 Minor 2）。io が無い
 * （getSessionTailState など fd を保持しない読み取り経路）場合はスキャンせず null を返す。見つかっても
 * cache へは書き込まない — この探索は履歴を遡る一回限りの救済であり、通常の chronological キャッシュの
 * 寿命管理（Minor 3a/3c）を乱さないため。
 */
function scanBackwardForAskUserQuestion(io: { fd: number; size: number }, before: number, toolUseId: string): AskUserQuestionItem[] | null {
  const scanParseLine = (line: string): AskUserQuestionItem[] | null => {
    if (!line) return null;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isRecord(record) || record.type !== 'assistant') return null;
    const message = record.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return null;
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'tool_use' && block.id === toolUseId && block.name === ASK_USER_QUESTION_TOOL_NAME) {
        return parseAskUserQuestionInput(block.input);
      }
    }
    return null;
  };

  const result = readBeforeWindow(io.fd, io.size, before, ASK_USER_QUESTION_BACKWARD_SCAN_BYTES, scanParseLine);
  return result.entries.length > 0 ? result.entries[0] : null;
}

function tryHandleAskUserQuestionResult(
  record: Record<string, unknown>,
  cache: Map<string, AskUserQuestionItem[]>,
  lineStart: number,
  io: { fd: number; size: number } | undefined,
): TranscriptEntry | null {
  if (record.type !== 'user') return null;
  if (typeof record.uuid !== 'string') return null;
  const message = record.message;
  if (!isRecord(message) || !Array.isArray(message.content) || message.content.length !== 1) return null;
  const block = message.content[0];
  if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return null;

  const toolUseId = block.tool_use_id;
  const items = cache.get(toolUseId) ?? (io ? scanBackwardForAskUserQuestion(io, lineStart, toolUseId) : null);
  if (!items) return null;

  const toolUseResult = record.toolUseResult;

  // 拒否された質問（Esc 等）には確定回答が無い。cache に残っていれば破棄し（Minor 3b）、通常の 'tool'
  // エントリへフォールバックする。
  if (toolUseResult === 'User rejected tool use') {
    cache.delete(toolUseId);
    return null;
  }

  if (!isRecord(toolUseResult) || !isRecord(toolUseResult.answers)) return null;

  cache.delete(toolUseId);

  const answersByQuestion = new Map<string, string>();
  for (const [question, value] of Object.entries(toolUseResult.answers)) {
    if (typeof value === 'string') answersByQuestion.set(question, value);
  }

  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
  return {
    uuid: record.uuid,
    type: 'interaction',
    timestamp,
    blocks: [],
    interaction: buildInteraction(items, answersByQuestion),
  };
}

/**
 * `<task-notification>...</task-notification>`（バックグラウンド task tool の完了通知、role=user・
 * content は文字列）の生XML整形（Issue #338 フェーズA）。判定はコマンド判定と同じ規律で content 全体の
 * 完全構造一致のみ（前方一致は禁止 — たまたま本文冒頭に同タグを書いたユーザー発言まで誤って
 * system 扱いにしないため）。該当する場合は type: 'system' + systemKind: 'task_notification' の
 * エントリへ変換し、`<summary>` の中身（無ければ空文字列）を blocks[0] のテキストに載せる
 * （フロントが「バックグラウンドタスク: {{summary}}」の専用文言を組み立てる）。
 */
const TASK_NOTIFICATION_PATTERN = /^<task-notification>[\s\S]*<\/task-notification>\s*$/;
const TASK_NOTIFICATION_SUMMARY_PATTERN = /<summary>([\s\S]*?)<\/summary>/;

function tryHandleTaskNotificationRecord(record: Record<string, unknown>): TranscriptEntry | null {
  if (record.type !== 'user') return null;
  // sidechain（サブエージェント内部の記録）は通常の除外ロジック（normalizeEntry/
  // tryHandleLocalCommandRecord）と同様に破棄する（レビュー指摘 Minor 4: このハンドラは
  // normalizeEntry より前に走るため、素通しすると sidechain の task-notification が可視化されてしまう）。
  if (record.isSidechain === true) return null;
  if (typeof record.uuid !== 'string') return null;
  const message = record.message;
  if (!isRecord(message) || typeof message.content !== 'string') return null;
  const content = message.content;
  if (!TASK_NOTIFICATION_PATTERN.test(content)) return null;

  const summaryMatch = TASK_NOTIFICATION_SUMMARY_PATTERN.exec(content);
  const summary = summaryMatch ? summaryMatch[1].trim() : '';
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
  return {
    uuid: record.uuid,
    type: 'system',
    timestamp,
    blocks: [{ kind: 'text', text: summary }],
    systemKind: 'task_notification',
  };
}

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
function normalizeEntry(
  record: unknown,
  askUserQuestionCache: Map<string, AskUserQuestionItem[]>,
  allowCacheWrite: boolean,
): TranscriptEntry | null {
  if (!isRecord(record)) return null;
  if (record.isSidechain === true) return null;
  if (record.type === 'summary') return null;

  const message = record.message;
  if (!isRecord(message)) return null;
  if (typeof record.uuid !== 'string') return null;

  const content =
    record.type === 'assistant' ? extractAskUserQuestionToolUse(message.content, askUserQuestionCache, allowCacheWrite) : message.content;

  const blocks = normalizeBlocks(content);
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

  // isMeta === true を必須にする（レビュー指摘 Minor 2）: 本文プレフィックスだけで判定すると、
  // ユーザーが本文冒頭にたまたま同じタグ文字列を書いた通常プロンプトまで黙って破棄してしまう。
  if (record.isMeta === true && content.startsWith(LOCAL_COMMAND_CAVEAT_PREFIX)) {
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
 * askUserQuestionCache（tool_use id → questions）はセッション単位でインスタンス寿命保持され
 * （呼び出し元 ClaudeTranscriptSource.getAskUserQuestionCache 参照）、tool_use と対応する
 * tool_result が別の読み取りウィンドウに分かれても質問群を失わない。
 *
 * options.io（fd/size）を渡すと、cache に無い AskUserQuestion tool_result 遭遇時に有界の後方スキャン
 * （Minor 2）を行える。省略時（例: getSessionTailState、fd を早期に close する経路）はスキャンしない。
 * options.allowCacheWrite（既定 true）を false にすると、この読み取りウィンドウでは
 * askUserQuestionCache へ一切書き込まない（Minor 3a: readSessionBefore の後方ページング用）。
 */
function buildParseLine(
  askUserQuestionCache: Map<string, AskUserQuestionItem[]>,
  options: { io?: { fd: number; size: number }; allowCacheWrite?: boolean } = {},
): (line: string, lineStart: number) => TranscriptEntry | null {
  const allowCacheWrite = options.allowCacheWrite ?? true;
  let pendingCommand: TranscriptEntry | null = null;
  return (line: string, lineStart: number): TranscriptEntry | null => {
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

    const taskNotificationEntry = tryHandleTaskNotificationRecord(record);
    if (taskNotificationEntry) return taskNotificationEntry;

    const interactionEntry = tryHandleAskUserQuestionResult(record, askUserQuestionCache, lineStart, options.io);
    if (interactionEntry) return interactionEntry;

    return normalizeEntry(record, askUserQuestionCache, allowCacheWrite);
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

  /**
   * セッション単位（sessionId → tool_use id → questions）の AskUserQuestion キャッシュ。インスタンス
   * 寿命内で保持し、tool_use と対応する tool_result が別の読み取りウィンドウに分かれても質問群を
   * 引き継げるようにする（CodexTranscriptSource.lastKnownModel と同じ位置付け）。
   */
  private readonly askUserQuestionCache = new Map<string, Map<string, AskUserQuestionItem[]>>();

  private getAskUserQuestionCache(sessionId: string): Map<string, AskUserQuestionItem[]> {
    let cache = this.askUserQuestionCache.get(sessionId);
    if (!cache) {
      cache = new Map();
      this.askUserQuestionCache.set(sessionId, cache);
    }
    return cache;
  }

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
      const parseLine = buildParseLine(this.getAskUserQuestionCache(sessionId), { io: { fd, size } });
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
      const parseLine = buildParseLine(this.getAskUserQuestionCache(sessionId), { io: { fd, size }, allowCacheWrite: false });
      return readBeforeWindow(fd, size, before, this.incrementalReadMaxBytes, parseLine);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 末尾 TAIL_STATE_SCAN_BYTES 分だけを読み、末尾から遡って最初にパース可能な行を分類する。 */
  async getSessionTailState(sessionId: string): Promise<SessionTailState> {
    const file = this.findSessionFile(sessionId);
    if (!file) return { state: 'unknown', lastEntryTimestampMs: null };

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
      return { state: 'unknown', lastEntryTimestampMs: null };
    }

    // io を渡さない: fd は上の try ブロックで既に close 済みのため、後方スキャン（Minor 2）は行えない。
    // 末尾窓のみを見るこの経路では未マッチのまま 'tool' 扱いにフォールバックしても、classifyTailEntry は
    // 'tool' と 'interaction' を同じ in_progress に分類するため稼働判定への影響はない。
    const parseLine = buildParseLine(this.getAskUserQuestionCache(sessionId));
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseLine(lines[i], 0);
      if (entry) return { state: classifyTailEntry(entry), lastEntryTimestampMs: parseEntryTimestampMs(entry) };
    }
    return { state: 'unknown', lastEntryTimestampMs: null };
  }
}
