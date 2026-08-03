import { describe, it, expect } from 'vitest';
import {
  buildFindLatestByMtime,
  buildListCandidatesWithMeta,
  formatNewermt,
  normalizePath,
  parseCandidates,
} from './sessionScanUtils';

describe('formatNewermt', () => {
  it('formats a Date as epoch seconds for find -newermt', () => {
    const timestamp = new Date('2026-07-15T12:34:56.789Z');

    expect(formatNewermt(timestamp)).toBe('@1784118896');
  });
});

describe('buildFindLatestByMtime', () => {
  it('builds a find command ordered by mtime without a timestamp filter', () => {
    const cmd = buildFindLatestByMtime('~/.codex/sessions/', 'rollout-*.jsonl');

    expect(cmd).toBe(
      "find ~/.codex/sessions/ -name 'rollout-*.jsonl' -type f 2>/dev/null -printf '%T@ %p\\n' | sort -rn | head -1 | cut -d' ' -f2-",
    );
    expect(cmd).not.toContain('-newermt');
  });

  it('builds a find command ordered by mtime with an epoch timestamp filter', () => {
    const timestamp = new Date('2026-07-15T12:34:56.789Z');
    const cmd = buildFindLatestByMtime('~/.claude/projects/example/', '*.jsonl', timestamp);

    expect(cmd).toBe(
      "find ~/.claude/projects/example/ -name '*.jsonl' -type f 2>/dev/null -newermt '@1784118896' -printf '%T@ %p\\n' | sort -rn | head -1 | cut -d' ' -f2-",
    );
  });
});

describe('buildListCandidatesWithMeta', () => {
  it('builds a candidate command without a timestamp filter', () => {
    expect(buildListCandidatesWithMeta('~/.codex/sessions/', 'rollout-*.jsonl')).toBe(
      `find ~/.codex/sessions/ -name 'rollout-*.jsonl' -type f 2>/dev/null -printf '%T@ %p\\n' | sort -n | while read t f; do echo "FILE:$f"; head -1 "$f"; done`,
    );
  });

  it('builds a candidate command with an epoch timestamp filter', () => {
    const timestamp = new Date('2026-07-15T12:34:56.789Z');
    expect(buildListCandidatesWithMeta('~/.codex/sessions/', 'rollout-*.jsonl', timestamp)).toContain(
      "-newermt '@1784118896' 2>/dev/null",
    );
  });
});

describe('parseCandidates', () => {
  it('parses session metadata and skips malformed candidates', () => {
    const output = [
      'FILE:/tmp/old.jsonl',
      '{"type":"session_meta","payload":{"session_id":"old","cwd":"/work/","originator":"codex"}}',
      'FILE:/tmp/bad.jsonl',
      'not json',
      'FILE:/tmp/missing.jsonl',
      '{"type":"session_meta","payload":{"cwd":"/work"}}',
    ].join('\n');

    expect(parseCandidates(output)).toEqual([
      { filePath: '/tmp/old.jsonl', sessionId: 'old', cwd: '/work/', originator: 'codex' },
    ]);
  });

  it('allows absent cwd and originator values', () => {
    expect(parseCandidates('FILE:/tmp/session.jsonl\n{"payload":{"session_id":"session"}}')).toEqual([
      { filePath: '/tmp/session.jsonl', sessionId: 'session', cwd: null, originator: null },
    ]);
  });
});

describe('normalizePath', () => {
  it('removes trailing slashes', () => {
    expect(normalizePath('/work/project///')).toBe('/work/project');
    expect(normalizePath('/work/project')).toBe('/work/project');
  });
});
