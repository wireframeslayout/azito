import type { IServerTransport } from '../transport/ServerTransport';
import type { IMuxClient } from '../../tmux/IMuxClient';
import type { ServerConfig } from '../Server';
import { tmuxTargetFromMuxRef } from '@azito/shared';

export interface WindowResource {
  target: string;
  rssBytes: number;
}

export async function measureWindowResources(transport: IServerTransport, muxClient: Pick<IMuxClient, 'measurePanePids'>, server: ServerConfig): Promise<WindowResource[]> {
  const [panePidEntries, psResult] = await Promise.all([
    muxClient.measurePanePids(server),
    transport.exec('ps -e -o pid=,ppid=,rss= 2>/dev/null', 5000),
  ]);

  if (psResult.code !== 0) return [];

  const panePids = new Map<string, number[]>();
  for (const entry of panePidEntries) {
    const target = tmuxTargetFromMuxRef(entry.ref);
    const existing = panePids.get(target);
    if (existing) existing.push(entry.pid);
    else panePids.set(target, [entry.pid]);
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
