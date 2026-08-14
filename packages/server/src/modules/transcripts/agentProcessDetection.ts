// ─── プロセス実体検査（WindowSessionResolver の agentDetected 判定レイヤー2） ───
//
// tmux の pane_current_command は OS の /proc/[pid]/comm 相当（フォアグラウンドプロセスの
// コマンド名）を報告する。Claude Code は node スクリプトとして起動するため、シェバン経由の
// exec ではプロセスの comm が "node" になり、pane_current_command だけでは claude/codex の
// 起動を検出できない（実機確認済み）。一方、ps の args（起動時の argv 全体。シェバン実行でも
// argv[0] は起動スクリプト名のまま保持されることが多い）を pane の子孫プロセスまで辿って調べれば、
// いずれかの引数トークンが claude/codex 実行体を指しているかを判定できる。
//
// この判定ロジック（parsePsOutput/argsContainAgentBinary/isAgentProcessRunning/
// findAgentProcessStartMs）は ps の実行や tmux 通信を一切含まない純粋関数として切り出してある —
// プロセス列挙は呼び出し側（WindowSessionResolver）が `ps -e -o pid=,ppid=,etimes=,args=` の
// 1回実行で担い、ここではその出力のパースと子孫探索・判定・起動時刻算出だけを行う。
// etimes（経過秒数）は、旧セッションの誤紐付けを防ぐプロセス起動時刻ゲート（Issue #338）用に
// 追加された列: 現在動作中のエージェントプロセスの起動時刻を `now - etimes*1000` で算出し、
// それより前に更新が止まっているセッションを「別の（古い）会話」として拒否する。

import path from 'path';

export interface PsEntry {
  pid: number;
  ppid: number;
  /** プロセスの経過秒数（`ps -o etimes=`）。起動時刻ゲート（Issue #338）用: `now - etimes*1000` で起動時刻を得る。 */
  etimes: number;
  args: string;
}

const AGENT_BINARY_NAMES = new Set(['claude', 'codex']);

/**
 * `ps -e -o pid=,ppid=,etimes=,args=` の出力（1行 = 1プロセス、先頭空白付き数値3列 + args）を
 * パースする。パース不能な行（空行・想定外フォーマット）はスキップする。
 */
export function parsePsOutput(output: string): PsEntry[] {
  const entries: PsEntry[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    const etimes = parseInt(match[3], 10);
    const args = match[4];
    if (Number.isNaN(pid) || Number.isNaN(ppid) || Number.isNaN(etimes) || args.length === 0) continue;
    entries.push({ pid, ppid, etimes, args });
  }
  return entries;
}

/**
 * args（プロセスの起動引数列全体、空白区切り）の中に claude/codex 実行体を示すトークンが
 * 含まれるか。各トークンをパス的に basename 化して比較する（例: `/usr/local/bin/claude` や
 * 先頭トークンの `claude` は一致、`--model` の値 `claude-opus-4-6` は一致しない）ため、
 * フラグ値の部分一致による誤検出を避けられる。
 */
export function argsContainAgentBinary(args: string): boolean {
  return args.split(/\s+/).some((token) => AGENT_BINARY_NAMES.has(path.basename(token)));
}

/**
 * args の中から claude/codex 実行体を示すトークンを探し、どちらの種別かを返す（Issue #338フォロー:
 * cwd 照合フォールバックの誤爆修正）。argsContainAgentBinary と同じトークン判定だが、真偽値ではなく
 * 種別そのものを返す。両方のトークンが同時に含まれることは実質無い（1プロセス1実行体）ため、
 * 最初に一致したものを返す。
 */
export function matchAgentBinaryName(args: string): 'claude' | 'codex' | null {
  for (const token of args.split(/\s+/)) {
    const base = path.basename(token);
    if (base === 'claude' || base === 'codex') return base;
  }
  return null;
}

/** rootPid 自身と、entries 上で辿れる子孫すべての pid 集合を返す（BFS）。 */
function collectDescendantPids(entries: PsEntry[], rootPid: number): Set<number> {
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
      if (visited.has(childPid)) continue; // ps スナップショットの循環は本来起こらないが念のため防止する
      visited.add(childPid);
      queue.push(childPid);
    }
  }
  return visited;
}

/**
 * rootPid 自身または子孫プロセスのいずれかが claude/codex を実行しているか。entries は
 * `ps -e -o pid=,ppid=,args=` を1回実行して得たスナップショット全体を想定する。rootPid が
 * entries 中に存在しない（pane 選択と ps 実行の間にプロセスが消えた等）場合は判定不能として false。
 */
export function isAgentProcessRunning(entries: PsEntry[], rootPid: number): boolean {
  const entryByPid = new Map(entries.map((entry) => [entry.pid, entry] as const));
  if (!entryByPid.has(rootPid)) return false;

  const descendantPids = collectDescendantPids(entries, rootPid);
  for (const pid of descendantPids) {
    const entry = entryByPid.get(pid);
    if (entry && argsContainAgentBinary(entry.args)) return true;
  }
  return false;
}

/**
 * rootPid 自身または子孫プロセスの中で claude/codex を実行しているものを探し、その起動時刻
 * （epoch ms; `nowMs - etimes*1000`）を返す（プロセス起動時刻ゲート、Issue #338）。探索ロジックは
 * isAgentProcessRunning と同じだが、一致したプロセスの起動時刻も必要とする点が異なる。複数一致時は
 * 最古（etimes が最大 = 最も長く動いている）ものを採用する（Issue #338フォロー: 「最新」採用だと、
 * エージェント本体プロセスが後から子ヘルパープロセス（claude/codex 実行体を含む短命プロセス等）を
 * 生やすたびに基準の起動時刻が繰り上がり、ゲートが本来のプロセス開始より後ろへずれて誤って
 * 正当なセッションを棄却しうる。ルートのエージェントプロセス自体が最も古いはずなので、最古を
 * 基準にすることでこの繰り上がりを避ける）。一致しなければ null。
 */
export function findAgentProcessStartMs(entries: PsEntry[], rootPid: number, nowMs: number): number | null {
  const entryByPid = new Map(entries.map((entry) => [entry.pid, entry] as const));
  if (!entryByPid.has(rootPid)) return null;

  const descendantPids = collectDescendantPids(entries, rootPid);
  let earliestStartMs: number | null = null;
  for (const pid of descendantPids) {
    const entry = entryByPid.get(pid);
    if (!entry || !argsContainAgentBinary(entry.args)) continue;
    const startMs = nowMs - entry.etimes * 1000;
    if (earliestStartMs === null || startMs < earliestStartMs) earliestStartMs = startMs;
  }
  return earliestStartMs;
}

/**
 * rootPids（このウィンドウの各 pane の pid）自身またはその子孫プロセスのいずれかが、args の中に
 * candidate sessionId をトークンとして含んでいるか（プロセス引数によるセッションID照合、Issue #338
 * フォロー: mtime ゲートより決定的な証拠）。AZITO の respawn/起動は `codex resume <id>` /
 * `claude --resume <id>` のようにセッションIDをプロセス引数へ直接渡すため、これが一致すれば
 * 「このプロセスが実際にこのセッションを再開して動いている」ことの直接証拠になり、mtime の前後関係
 * （supervisor 経由の起動でファイル作成がプロセス起動に先行し得る）に左右されない。トークン単位の
 * 完全一致で比較する（部分一致による誤検出を避けるため、argsContainAgentBinary と同じ方針）。
 */
export function argsContainSessionId(entries: PsEntry[], rootPids: number[], sessionId: string): boolean {
  if (!sessionId) return false;
  const entryByPid = new Map(entries.map((entry) => [entry.pid, entry] as const));

  const descendantPids = new Set<number>();
  for (const rootPid of rootPids) {
    if (!entryByPid.has(rootPid)) continue;
    for (const pid of collectDescendantPids(entries, rootPid)) descendantPids.add(pid);
  }

  for (const pid of descendantPids) {
    const entry = entryByPid.get(pid);
    if (entry && entry.args.split(/\s+/).includes(sessionId)) return true;
  }
  return false;
}

/**
 * rootPid 自身または子孫プロセスの中で実際に検出できた claude/codex 実行体の種別集合を返す
 * （cwd 照合フォールバックの誤爆修正、Issue #338フォロー）。同一 pane で claude/codex どちらが
 * 動いているかを判定するために使う — 複数の pane を持つウィンドウで両方が見つかることもあるため
 * Set を返す。一致が無ければ空集合。
 */
export function findAgentProcessTypes(entries: PsEntry[], rootPid: number): Set<'claude' | 'codex'> {
  const entryByPid = new Map(entries.map((entry) => [entry.pid, entry] as const));
  const types = new Set<'claude' | 'codex'>();
  if (!entryByPid.has(rootPid)) return types;

  const descendantPids = collectDescendantPids(entries, rootPid);
  for (const pid of descendantPids) {
    const entry = entryByPid.get(pid);
    if (!entry) continue;
    const matched = matchAgentBinaryName(entry.args);
    if (matched) types.add(matched);
  }
  return types;
}
