export function formatNewermt(timestamp: Date): string {
  return `@${Math.floor(timestamp.getTime() / 1000)}`;
}

export function buildFindLatestByMtime(basePath: string, namePattern: string, afterTimestamp?: Date): string {
  let cmd = `find ${basePath} -name '${namePattern}' -type f 2>/dev/null`;
  if (afterTimestamp) {
    cmd += ` -newermt '${formatNewermt(afterTimestamp)}'`;
  }
  cmd += ` -printf '%T@ %p\\n' | sort -rn | head -1 | cut -d' ' -f2-`;
  return cmd;
}

export interface RolloutCandidate {
  filePath: string;
  sessionId: string;
  cwd: string | null;
  originator: string | null;
}

export function buildListCandidatesWithMeta(basePath: string, namePattern: string, afterTimestamp?: Date): string {
  let cmd = `find ${basePath} -name '${namePattern}' -type f`;
  if (afterTimestamp) {
    cmd += ` -newermt '${formatNewermt(afterTimestamp)}'`;
  }
  return `${cmd} 2>/dev/null -printf '%T@ %p\\n' | sort -n | while read t f; do echo "FILE:$f"; head -1 "$f"; done`;
}

export function parseCandidates(output: string): RolloutCandidate[] {
  const lines = output.split('\n');
  const candidates: RolloutCandidate[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const filePath = lines[i].startsWith('FILE:') ? lines[i].slice('FILE:'.length) : null;
    if (!filePath) continue;
    try {
      const parsed: unknown = JSON.parse(lines[i + 1]);
      if (typeof parsed !== 'object' || parsed === null) continue;
      const payload = (parsed as { payload?: unknown }).payload;
      if (typeof payload !== 'object' || payload === null) continue;
      const meta = payload as { session_id?: unknown; cwd?: unknown; originator?: unknown };
      if (typeof meta.session_id !== 'string' || !meta.session_id) continue;
      candidates.push({
        filePath,
        sessionId: meta.session_id,
        cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
        originator: typeof meta.originator === 'string' ? meta.originator : null,
      });
      i++;
    } catch {
      continue;
    }
  }
  return candidates;
}

export function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}
