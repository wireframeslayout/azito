import type { IServerTransport } from '../transport/ServerTransport';
import type { IMuxClient } from '../../tmux/IMuxClient';
import type { ServerConfig } from '../Server';
import { formatMuxRef, type MuxRef } from '@azito/shared';
import { muxWindowTarget } from '../../tmux/muxWindowTarget';

export interface WindowResource {
  /** Display key (`<workspace>:<window>`; misao: the window id). */
  target: string;
  /** The window's `formatMuxRef` — what the ref-based window routes take, so a window can be acted on whatever its driver. */
  ref: string;
  rssBytes: number;
}

export async function measureWindowResources(transport: IServerTransport, muxClient: Pick<IMuxClient, 'measurePanePids'>, server: ServerConfig): Promise<WindowResource[]> {
  const [panePidEntries, processList] = await Promise.all([
    muxClient.measurePanePids(server),
    transport.listProcesses(),
  ]);

  const panePids = new Map<string, { ref: MuxRef; pids: number[] }>();
  for (const entry of panePidEntries) {
    const target = muxWindowTarget(entry.ref);
    const existing = panePids.get(target);
    if (existing) existing.pids.push(entry.pid);
    else panePids.set(target, { ref: entry.ref, pids: [entry.pid] });
  }

  if (panePids.size === 0) return [];

  const processes = new Map<number, { ppid: number; rss: number }>();
  for (const proc of processList) {
    // A host that does not report a process's memory contributes nothing for it.
    processes.set(proc.pid, { ppid: proc.ppid, rss: proc.rssBytes ?? 0 });
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
    const visited = new Set<number>([rootPid]); // Windows reuses pids, so parent links can form a loop
    while (queue.length > 0) {
      const childPid = queue.pop()!;
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      total +=processes.get(childPid)?.rss ?? 0;
      const grandchildren = children.get(childPid);
      if (grandchildren) queue.push(...grandchildren);
    }
    return total;
  };

  const results: WindowResource[] = [];
  for (const [target, { ref, pids }] of panePids) {
    let totalRss = 0;
    for (const pid of pids) {
      totalRss += collectTreeRss(pid);
    }
    results.push({ target, ref: formatMuxRef(ref), rssBytes: totalRss });
  }

  results.sort((a, b) => b.rssBytes - a.rssBytes);
  return results;
}
