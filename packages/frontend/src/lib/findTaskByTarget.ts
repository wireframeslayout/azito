import { parseMuxRef, type MuxRef } from '@azito/shared';

const W_ID_RE = /^w(\d+)$/;

interface WindowEntry {
  taskId?: number;
  tmuxTarget?: string;
  muxRef?: MuxRef;
}

function muxRefEquals(a: MuxRef, b: MuxRef): boolean {
  return a.kind === b.kind && a.workspace === b.workspace && a.window === b.window;
}

function tryParseMuxRef(s: string): MuxRef | null {
  if (!s.startsWith('{')) return null;
  try { return parseMuxRef(s); } catch { return null; }
}

export function findTaskByTarget<T extends { id: number; tmuxWindow?: string }>(
  target: string,
  taskLists: readonly (readonly T[])[],
  windowById: Map<number, WindowEntry>,
): T | null {
  const wMatch = W_ID_RE.exec(target);
  if (wMatch) {
    const win = windowById.get(parseInt(wMatch[1], 10));
    if (win?.taskId != null) {
      for (const tasks of taskLists) {
        const found = tasks.find(t => t.id === win.taskId);
        if (found) return found;
      }
    }
    return null;
  }

  const ref = tryParseMuxRef(target);
  if (ref) {
    for (const [, win] of windowById) {
      if (win.muxRef && muxRefEquals(win.muxRef, ref) && win.taskId != null) {
        for (const tasks of taskLists) {
          const found = tasks.find(t => t.id === win.taskId);
          if (found) return found;
        }
        return null;
      }
    }
    return null;
  }

  const parts = target.split(':');
  if (parts.length < 2) return null;
  const windowName = parts[1].split('.')[0];
  for (const tasks of taskLists) {
    const found = tasks.find(t => t.tmuxWindow === windowName);
    if (found) return found;
  }
  return null;
}
