// ─── プロセス実体検査（WindowSessionResolver の agentDetected 判定レイヤー2） ───
//
// tmux の pane_current_command は OS の /proc/[pid]/comm 相当（フォアグラウンドプロセスの
// コマンド名）を報告する。Claude Code は node スクリプトとして起動するため、シェバン経由の
// exec ではプロセスの comm が "node" になり、pane_current_command だけでは claude/codex の
// 起動を検出できない（実機確認済み）。一方、ps の args（起動時の argv 全体。シェバン実行でも
// argv[0] は起動スクリプト名のまま保持されることが多い）を pane の子孫プロセスまで辿って調べれば、
// いずれかの引数トークンが claude/codex 実行体を指しているかを判定できる。
//
// この判定ロジック（parsePsOutput/argsContainAgentBinary/isAgentProcessRunning）は ps の実行や
// tmux 通信を一切含まない純粋関数として切り出してある — プロセス列挙は呼び出し側
// （WindowSessionResolver）が `ps -e -o pid=,ppid=,args=` の1回実行で担い、ここではその出力の
// パースと子孫探索・判定だけを行う。

import path from 'path';

export interface PsEntry {
  pid: number;
  ppid: number;
  args: string;
}

const AGENT_BINARY_NAMES = new Set(['claude', 'codex']);

/**
 * `ps -e -o pid=,ppid=,args=` の出力（1行 = 1プロセス、先頭空白付き数値2列 + args）をパースする。
 * パース不能な行（空行・想定外フォーマット）はスキップする。
 */
export function parsePsOutput(output: string): PsEntry[] {
  const entries: PsEntry[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    const args = match[3];
    if (Number.isNaN(pid) || Number.isNaN(ppid) || args.length === 0) continue;
    entries.push({ pid, ppid, args });
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
