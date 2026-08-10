import { describe, it, expect } from 'vitest';
import { parsePsOutput, argsContainAgentBinary, isAgentProcessRunning, findAgentProcessStartMs, argsContainSessionId } from './agentProcessDetection';
import type { PsEntry } from './agentProcessDetection';

describe('parsePsOutput', () => {
  it('parses pid/ppid/etimes/args lines with leading whitespace (ps -e -o pid=,ppid=,etimes=,args= format)', () => {
    const output = [
      '  59026   58986      42 claude --dangerously-skip-permissions --model claude-opus-4-6[1m]',
      '     1       0  123456 /sbin/init',
    ].join('\n');
    expect(parsePsOutput(output)).toEqual<PsEntry[]>([
      { pid: 59026, ppid: 58986, etimes: 42, args: 'claude --dangerously-skip-permissions --model claude-opus-4-6[1m]' },
      { pid: 1, ppid: 0, etimes: 123456, args: '/sbin/init' },
    ]);
  });

  it('skips blank lines and malformed rows', () => {
    const output = ['', '  not a valid line', '     123   1  10 bash'].join('\n');
    expect(parsePsOutput(output)).toEqual<PsEntry[]>([{ pid: 123, ppid: 1, etimes: 10, args: 'bash' }]);
  });

  it('skips a row missing the etimes column (only pid/ppid/args)', () => {
    const output = '  123   1 bash';
    expect(parsePsOutput(output)).toEqual<PsEntry[]>([]);
  });
});

describe('argsContainAgentBinary', () => {
  it('matches a bare binary name token', () => {
    expect(argsContainAgentBinary('claude --dangerously-skip-permissions')).toBe(true);
    expect(argsContainAgentBinary('codex --dangerously-bypass-approvals-and-sandbox')).toBe(true);
  });

  it('matches a path whose basename is claude/codex', () => {
    expect(argsContainAgentBinary('/home/user/.local/bin/claude --resume abc')).toBe(true);
    expect(argsContainAgentBinary('/opt/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex --model gpt-5.6-sol')).toBe(true);
  });

  it('does not match a flag value that merely contains "claude" as a substring', () => {
    expect(argsContainAgentBinary('node /usr/lib/node_modules/foo/cli.js --model claude-opus-4-6[1m]')).toBe(false);
  });

  it('does not match unrelated commands', () => {
    expect(argsContainAgentBinary('/bin/bash -c "echo hi"')).toBe(false);
    expect(argsContainAgentBinary('vim file.ts')).toBe(false);
  });
});

describe('isAgentProcessRunning', () => {
  it('detects claude running as a grandchild process (shebang-launched node wrapper in between)', () => {
    const entries: PsEntry[] = [
      { pid: 100, ppid: 1, etimes: 60, args: 'node /path/to/azito-supervisor.cjs -- claude --dangerously-skip-permissions' },
      { pid: 200, ppid: 100, etimes: 55, args: 'node /path/to/some-wrapper.js' },
      { pid: 300, ppid: 200, etimes: 50, args: 'claude --dangerously-skip-permissions --model claude-opus-4-6[1m]' },
    ];
    expect(isAgentProcessRunning(entries, 100)).toBe(true);
  });

  it('returns false when the process tree runs node but no descendant args reference claude/codex', () => {
    const entries: PsEntry[] = [
      { pid: 100, ppid: 1, etimes: 60, args: 'node /path/to/some-other-script.js --flag value' },
      { pid: 200, ppid: 100, etimes: 55, args: '/bin/bash -c "npm run build"' },
    ];
    expect(isAgentProcessRunning(entries, 100)).toBe(false);
  });

  it('detects codex when the codex binary is invoked directly as the root process', () => {
    const entries: PsEntry[] = [
      { pid: 500, ppid: 1, etimes: 10, args: '/opt/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex --dangerously-bypass-approvals-and-sandbox' },
    ];
    expect(isAgentProcessRunning(entries, 500)).toBe(true);
  });

  it('returns false when the root pid is not present in the ps snapshot', () => {
    const entries: PsEntry[] = [{ pid: 1, ppid: 0, etimes: 999999, args: '/sbin/init' }];
    expect(isAgentProcessRunning(entries, 999)).toBe(false);
  });
});

describe('findAgentProcessStartMs', () => {
  const NOW = 1_700_000_000_000;

  it('computes the start time of the matched descendant process from its etimes', () => {
    const entries: PsEntry[] = [
      { pid: 100, ppid: 1, etimes: 90, args: 'node /path/to/some-wrapper.js' },
      { pid: 300, ppid: 100, etimes: 42, args: 'claude --dangerously-skip-permissions --model claude-opus-4-6[1m]' },
    ];
    expect(findAgentProcessStartMs(entries, 100, NOW)).toBe(NOW - 42 * 1000);
  });

  it('picks the earliest-started (largest etimes = longest-running) match when multiple descendants reference an agent binary (Issue #338 follow-up: a later-spawned short-lived helper must not push the baseline forward)', () => {
    const entries: PsEntry[] = [
      { pid: 100, ppid: 1, etimes: 90, args: 'node /path/to/wrapper.js' },
      { pid: 200, ppid: 100, etimes: 80, args: 'claude --resume abc' },
      { pid: 201, ppid: 100, etimes: 5, args: 'claude --dangerously-skip-permissions' },
    ];
    expect(findAgentProcessStartMs(entries, 100, NOW)).toBe(NOW - 80 * 1000);
  });

  it('returns null when no descendant references claude/codex', () => {
    const entries: PsEntry[] = [
      { pid: 100, ppid: 1, etimes: 60, args: 'node /path/to/some-other-script.js' },
    ];
    expect(findAgentProcessStartMs(entries, 100, NOW)).toBeNull();
  });

  it('returns null when the root pid is not present in the ps snapshot', () => {
    const entries: PsEntry[] = [{ pid: 1, ppid: 0, etimes: 999999, args: '/sbin/init' }];
    expect(findAgentProcessStartMs(entries, 999, NOW)).toBeNull();
  });
});

describe('argsContainSessionId', () => {
  const SESSION_ID = '019fea40-1234-7abc-8def-0123456789ab';

  it('matches a session id passed as a `codex resume <id>` argument on a descendant process', () => {
    const entries: PsEntry[] = [
      { pid: 9000, ppid: 1, etimes: 50, args: 'node /path/to/azito-supervisor.cjs -- codex resume ' + SESSION_ID },
      { pid: 9001, ppid: 9000, etimes: 9, args: '/opt/codex/bin/codex resume ' + SESSION_ID },
    ];
    expect(argsContainSessionId(entries, [9000], SESSION_ID)).toBe(true);
  });

  it('matches a session id passed as a `claude --resume <id>` argument', () => {
    const entries: PsEntry[] = [{ pid: 300, ppid: 1, etimes: 10, args: 'claude --resume ' + SESSION_ID }];
    expect(argsContainSessionId(entries, [300], SESSION_ID)).toBe(true);
  });

  it('does not match when the session id only appears as a substring of another token', () => {
    const entries: PsEntry[] = [{ pid: 300, ppid: 1, etimes: 10, args: `claude --resume ${SESSION_ID}-not-the-same` }];
    expect(argsContainSessionId(entries, [300], SESSION_ID)).toBe(false);
  });

  it('returns false when no rootPid is present in the ps snapshot', () => {
    const entries: PsEntry[] = [{ pid: 1, ppid: 0, etimes: 999999, args: '/sbin/init' }];
    expect(argsContainSessionId(entries, [999], SESSION_ID)).toBe(false);
  });

  it('returns false for an empty sessionId', () => {
    const entries: PsEntry[] = [{ pid: 300, ppid: 1, etimes: 10, args: 'claude --resume ' + SESSION_ID }];
    expect(argsContainSessionId(entries, [300], '')).toBe(false);
  });
});
