import type { IServerTransport } from '../transport/ServerTransport';

export interface WindowResource {
  target: string;
  rssBytes: number;
}

/** Per-browser-tab linked sessions AZITO creates (see LocalTransport.openTerminal). */
const LINKED_SESSION_PREFIX = '_azito_';

/**
 * Picks which of two targets naming the same window to report. The source
 * session is preferred over the throwaway linked ones so the UI shows the
 * stable name; between two of the same kind the first one wins (stable order).
 */
function preferredTarget(current: string, candidate: string): string {
  const currentLinked = current.startsWith(LINKED_SESSION_PREFIX);
  const candidateLinked = candidate.startsWith(LINKED_SESSION_PREFIX);
  if (currentLinked && !candidateLinked) return candidate;
  return current;
}

export async function measureWindowResources(transport: IServerTransport): Promise<WindowResource[]> {
  const [panesResult, psResult] = await Promise.all([
    transport.exec("tmux list-panes -a -F '#{session_name}:#{window_name} #{pane_pid}' 2>/dev/null", 5000),
    // `-o <col>=` suppresses the header portably; `--no-headers` is a procps
    // extension that BSD ps (macOS) rejects outright with a usage error.
    transport.exec('ps -e -o pid=,ppid=,rss= 2>/dev/null', 5000),
  ]);

  if (panesResult.code !== 0 || psResult.code !== 0) return [];

  // A window linked into several sessions (AZITO creates one `tmux new-session -t`
  // per browser tab) is the *same* tmux window object, so `list-panes -a` reports
  // its panes once per session. Keying by pane pid collapses those duplicates;
  // without it a single window is listed 2-3 times and its RSS counted as many.
  const windowByPid = new Map<number, string>();
  for (const line of panesResult.stdout.trim().split('\n')) {
    if (!line) continue;
    const spaceIdx = line.lastIndexOf(' ');
    if (spaceIdx === -1) continue;
    // The format has no pane suffix (`#{session_name}:#{window_name}`), so the
    // target is used as-is — splitting on '.' would truncate window names that
    // legitimately contain one and attribute the panes to a different window.
    const windowTarget = line.slice(0, spaceIdx);
    const pid = parseInt(line.slice(spaceIdx + 1), 10);
    if (!Number.isFinite(pid)) continue;

    const known = windowByPid.get(pid);
    if (known === undefined || preferredTarget(known, windowTarget) === windowTarget) {
      windowByPid.set(pid, windowTarget);
    }
  }

  const panePids = new Map<string, number[]>();
  for (const [pid, windowTarget] of windowByPid) {
    const existing = panePids.get(windowTarget);
    if (existing) existing.push(pid);
    else panePids.set(windowTarget, [pid]);
  }

  if (panePids.size === 0) return [];

  const processes = new Map<number, { ppid: number; rss: number }>();
  for (const line of psResult.stdout.trim().split('\n')) {
    if (!line) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const rssKb = parseInt(parts[2], 10);
    if (Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(rssKb)) {
      processes.set(pid, { ppid, rss: rssKb * 1024 });
    }
  }

  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of processes) {
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }

  const collectTreeRss = (rootPid: number): number => {
    let total = processes.get(rootPid)?.rss ?? 0;
    const stack = children.get(rootPid);
    if (!stack) return total;
    const queue = [...stack];
    while (queue.length > 0) {
      const childPid = queue.pop()!;
      total += processes.get(childPid)?.rss ?? 0;
      const grandchildren = children.get(childPid);
      if (grandchildren) queue.push(...grandchildren);
    }
    return total;
  };

  const results: WindowResource[] = [];
  for (const [target, pids] of panePids) {
    let totalRss = 0;
    for (const pid of pids) {
      totalRss += collectTreeRss(pid);
    }
    results.push({ target, rssBytes: totalRss });
  }

  results.sort((a, b) => b.rssBytes - a.rssBytes);
  return results;
}
