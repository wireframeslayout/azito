// ─── プロセス実体検査（WindowSessionResolver の agentDetected 判定レイヤー2） ───
//
// tmux の pane_current_command は OS の /proc/[pid]/comm 相当（フォアグラウンドプロセスの
// コマンド名）を報告する。Claude Code は node スクリプトとして起動するため、シェバン経由の
// exec ではプロセスの comm が "node" になり、pane_current_command だけでは claude/codex の
// 起動を検出できない（実機確認済み）。一方、コマンドライン（起動時の argv 全体。シェバン実行でも
// argv[0] は起動スクリプト名のまま保持されることが多い）を pane の子孫プロセスまで辿って調べれば、
// いずれかの引数トークンが claude/codex 実行体を指しているかを判定できる。
//
// この判定ロジック（argsContainAgentBinary/isAgentProcessRunning/findAgentProcessStartMs）は
// プロセスの列挙や tmux 通信を一切含まない純粋関数として切り出してある — プロセス列挙は
// transport.listProcesses()（OS 共通の ProcessEntry、shared/os/processList.ts）が担い、ここでは
// 子孫探索・判定・起動時刻の算出だけを行う。startMs（起動時刻）は、旧セッションの誤紐付けを防ぐ
// プロセス起動時刻ゲート（Issue #338）用: 現在動作中のエージェントプロセスの起動時刻より前に
// 更新が止まっているセッションを「別の（古い）会話」として拒否する。
//
// 相手の OS はハブと違いうる（POSIX のハブから見た Windows の agent）ため、パスの区切りは / と \ の
// 両方を見て、ハブ自身の path モジュールには頼らない。Windows の実行体は拡張子（.exe/.cmd/...）付きで、
// npm 版は `node.exe ...\@anthropic-ai\claude-code\cli.js` のように node のスクリプトとして現れる。

import type { ProcessEntry } from '../../shared/os/processList';

type AgentName = 'claude' | 'codex';

const AGENT_BINARY_NAMES: ReadonlySet<string> = new Set<AgentName>(['claude', 'codex']);

/** Windows の実行体の拡張子（`claude.exe`、npm のシム `claude.cmd`）。比較の前に外す。 */
const EXECUTABLE_EXTENSION = /\.(exe|cmd|bat|ps1)$/i;

/** npm 版のエージェント（node が起動するスクリプト）。パッケージの入口のスクリプトだけを指す（同じパッケージ配下の別ファイルは対象外）。 */
const NPM_AGENT_SCRIPTS: ReadonlyArray<{ pattern: RegExp; name: AgentName }> = [
  { pattern: /[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.m?js$/, name: 'claude' },
  { pattern: /[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/, name: 'codex' },
];

/** コマンドラインをトークンに分ける。Windows の引用（`"C:\Program Files\nodejs\node.exe" "...\cli.js"`）の中の空白は区切りにしない。 */
function tokenizeCommandLine(commandLine: string): string[] {
  return Array.from(commandLine.matchAll(/"([^"]*)"|\S+/g), (m) => m[1] ?? m[0]);
}

/** トークンが claude/codex の実行体を指すならその種別。 */
function agentNameOfToken(token: string): AgentName | null {
  const base = token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1).replace(EXECUTABLE_EXTENSION, '').toLowerCase();
  if (AGENT_BINARY_NAMES.has(base)) return base as AgentName;
  return NPM_AGENT_SCRIPTS.find((script) => script.pattern.test(token))?.name ?? null;
}

function commandTokens(entry: ProcessEntry): string[] {
  const tokens = tokenizeCommandLine(entry.commandLine);
  return entry.executable === null ? tokens : [entry.executable, ...tokens];
}

/**
 * プロセスのコマンドライン（と実行ファイル）の中に claude/codex 実行体を示すトークンが含まれるか。
 * 各トークンを basename 化して比較する（例: `/usr/local/bin/claude` や `C:\...\claude.exe` や
 * 先頭トークンの `claude` は一致、`--model` の値 `claude-opus-4-6` は一致しない）ため、
 * フラグ値の部分一致による誤検出を避けられる。
 */
export function argsContainAgentBinary(entry: ProcessEntry): boolean {
  return matchAgentBinaryName(entry) !== null;
}

/**
 * プロセスから claude/codex 実行体を示すトークンを探し、どちらの種別かを返す（Issue #338フォロー:
 * cwd 照合フォールバックの誤爆修正）。argsContainAgentBinary と同じトークン判定だが、真偽値ではなく
 * 種別そのものを返す。両方のトークンが同時に含まれることは実質無い（1プロセス1実行体）ため、
 * 最初に一致したものを返す。
 */
export function matchAgentBinaryName(entry: ProcessEntry): AgentName | null {
  for (const token of commandTokens(entry)) {
    const name = agentNameOfToken(token);
    if (name) return name;
  }
  return null;
}

/** rootPid 自身と、entries 上で辿れる子孫すべての pid 集合を返す（BFS）。 */
function collectDescendantPids(entries: ProcessEntry[], rootPid: number): Set<number> {
  const childrenByPpid = new Map<number, number[]>();
  for (const entry of entries) {
    const list = childrenByPpid.get(entry.ppid);
    if (list) list.push(entry.pid);
    else childrenByPpid.set(entry.ppid, [entry.pid]);
  }

  const visited = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const childPid of childrenByPpid.get(pid) ?? []) {
      if (visited.has(childPid)) continue; // スナップショットの循環は本来起こらないが念のため防止する（Windows は pid の再利用で親子が輪になりうる）
      visited.add(childPid);
      queue.push(childPid);
    }
  }
  return visited;
}

/**
 * rootPid 自身または子孫プロセスのいずれかが claude/codex を実行しているか。entries は
 * プロセス一覧を1回取得して得たスナップショット全体を想定する。rootPid が
 * entries 中に存在しない（pane 選択と一覧取得の間にプロセスが消えた等）場合は判定不能として false。
 */
export function isAgentProcessRunning(entries: ProcessEntry[], rootPid: number): boolean {
  const entryByPid = new Map(entries.map((entry) => [entry.pid, entry] as const));
  if (!entryByPid.has(rootPid)) return false;

  const descendantPids = collectDescendantPids(entries, rootPid);
  for (const pid of descendantPids) {
    const entry = entryByPid.get(pid);
    if (entry && argsContainAgentBinary(entry)) return true;
  }
  return false;
}

/**
 * rootPid 自身または子孫プロセスの中で claude/codex を実行しているものを探し、その起動時刻
 * （epoch ms; ProcessEntry.startMs）を返す（プロセス起動時刻ゲート、Issue #338）。探索ロジックは
 * isAgentProcessRunning と同じだが、一致したプロセスの起動時刻も必要とする点が異なる。複数一致時は
 * 最古（最も長く動いている）ものを採用する（Issue #338フォロー: 「最新」採用だと、
 * エージェント本体プロセスが後から子ヘルパープロセス（claude/codex 実行体を含む短命プロセス等）を
 * 生やすたびに基準の起動時刻が繰り上がり、ゲートが本来のプロセス開始より後ろへずれて誤って
 * 正当なセッションを棄却しうる。ルートのエージェントプロセス自体が最も古いはずなので、最古を
 * 基準にすることでこの繰り上がりを避ける）。起動時刻が分からないプロセス（startMs が null）は
 * 基準にしない。一致しなければ null。
 */
export function findAgentProcessStartMs(entries: ProcessEntry[], rootPid: number): number | null {
  const entryByPid = new Map(entries.map((entry) => [entry.pid, entry] as const));
  if (!entryByPid.has(rootPid)) return null;

  const descendantPids = collectDescendantPids(entries, rootPid);
  let earliestStartMs: number | null = null;
  for (const pid of descendantPids) {
    const entry = entryByPid.get(pid);
    if (!entry || entry.startMs === null || !argsContainAgentBinary(entry)) continue;
    if (earliestStartMs === null || entry.startMs < earliestStartMs) earliestStartMs = entry.startMs;
  }
  return earliestStartMs;
}

/**
 * rootPids（このウィンドウの各 pane の pid）自身またはその子孫プロセスのいずれかが、コマンドラインの中に
 * candidate sessionId をトークンとして含んでいるか（プロセス引数によるセッションID照合、Issue #338
 * フォロー: mtime ゲートより決定的な証拠）。AZITO の respawn/起動は `codex resume <id>` /
 * `claude --resume <id>` のようにセッションIDをプロセス引数へ直接渡すため、これが一致すれば
 * 「このプロセスが実際にこのセッションを再開して動いている」ことの直接証拠になり、mtime の前後関係
 * （supervisor 経由の起動でファイル作成がプロセス起動に先行し得る）に左右されない。トークン単位の
 * 完全一致で比較する（部分一致による誤検出を避けるため、argsContainAgentBinary と同じ方針）。
 */
export function argsContainSessionId(entries: ProcessEntry[], rootPids: number[], sessionId: string): boolean {
  if (!sessionId) return false;
  const entryByPid = new Map(entries.map((entry) => [entry.pid, entry] as const));

  const descendantPids = new Set<number>();
  for (const rootPid of rootPids) {
    if (!entryByPid.has(rootPid)) continue;
    for (const pid of collectDescendantPids(entries, rootPid)) descendantPids.add(pid);
  }

  for (const pid of descendantPids) {
    const entry = entryByPid.get(pid);
    if (entry && tokenizeCommandLine(entry.commandLine).includes(sessionId)) return true;
  }
  return false;
}

/**
 * rootPid 自身または子孫プロセスの中で実際に検出できた claude/codex 実行体の種別集合を返す
 * （cwd 照合フォールバックの誤爆修正、Issue #338フォロー）。同一 pane で claude/codex どちらが
 * 動いているかを判定するために使う — 複数の pane を持つウィンドウで両方が見つかることもあるため
 * Set を返す。一致が無ければ空集合。
 */
export function findAgentProcessTypes(entries: ProcessEntry[], rootPid: number): Set<AgentName> {
  const entryByPid = new Map(entries.map((entry) => [entry.pid, entry] as const));
  const types = new Set<AgentName>();
  if (!entryByPid.has(rootPid)) return types;

  const descendantPids = collectDescendantPids(entries, rootPid);
  for (const pid of descendantPids) {
    const entry = entryByPid.get(pid);
    if (!entry) continue;
    const matched = matchAgentBinaryName(entry);
    if (matched) types.add(matched);
  }
  return types;
}
