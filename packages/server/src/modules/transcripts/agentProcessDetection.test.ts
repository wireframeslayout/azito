import { describe, it, expect } from 'vitest';
import { argsContainAgentBinary, isAgentProcessRunning, findAgentProcessStartMs, findAgentProcessTypes, argsContainSessionId } from './agentProcessDetection';
import type { ProcessEntry } from '../../shared/os/processList';

const NOW = 1_700_000_000_000;

/** A process that has been running for `elapsedSec` seconds at NOW. */
function proc(pid: number, ppid: number, elapsedSec: number, commandLine: string, executable: string | null = null): ProcessEntry {
  return { pid, ppid, startMs: NOW - elapsedSec * 1000, executable, commandLine, rssBytes: null };
}

describe('argsContainAgentBinary', () => {
  it('matches a bare binary name token', () => {
    expect(argsContainAgentBinary(proc(1, 0, 1, 'claude --dangerously-skip-permissions'))).toBe(true);
    expect(argsContainAgentBinary(proc(1, 0, 1, 'codex --dangerously-bypass-approvals-and-sandbox'))).toBe(true);
  });

  it('matches a path whose basename is claude/codex', () => {
    expect(argsContainAgentBinary(proc(1, 0, 1, '/home/user/.local/bin/claude --resume abc'))).toBe(true);
    expect(argsContainAgentBinary(proc(1, 0, 1, '/opt/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex --model gpt-5.6-sol'))).toBe(true);
  });

  it('does not match a flag value that merely contains "claude" as a substring', () => {
    expect(argsContainAgentBinary(proc(1, 0, 1, 'node /usr/lib/node_modules/foo/cli.js --model claude-opus-4-6[1m]'))).toBe(false);
  });

  it('does not match unrelated commands', () => {
    expect(argsContainAgentBinary(proc(1, 0, 1, '/bin/bash -c "echo hi"'))).toBe(false);
    expect(argsContainAgentBinary(proc(1, 0, 1, 'vim file.ts'))).toBe(false);
  });

  describe('a Windows agent seen from a POSIX hub', () => {
    it('matches the native binaries with their .exe extension, quoted or not, and a path with spaces', () => {
      expect(argsContainAgentBinary(proc(1, 0, 1, '"C:\\Users\\me\\.local\\bin\\claude.exe" --resume abc'))).toBe(true);
      expect(argsContainAgentBinary(proc(1, 0, 1, 'C:\\tools\\codex.exe --model gpt-5.6-sol'))).toBe(true);
      expect(argsContainAgentBinary(proc(1, 0, 1, '"C:\\Program Files\\Codex\\CODEX.EXE" resume x'))).toBe(true);
    });

    it('matches the executable path even when the command line is hidden', () => {
      expect(argsContainAgentBinary(proc(1, 0, 1, '', 'C:\\Users\\me\\.local\\bin\\claude.exe'))).toBe(true);
    });

    it('matches the npm shims and the npm package scripts run by node.exe', () => {
      expect(argsContainAgentBinary(proc(1, 0, 1, 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd --resume abc'))).toBe(true);
      expect(argsContainAgentBinary(proc(1, 0, 1, '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" --resume abc'))).toBe(true);
      expect(argsContainAgentBinary(proc(1, 0, 1, 'node.exe C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'))).toBe(true);
    });

    it('does not match a node script of an unrelated package or another file of the agent package', () => {
      expect(argsContainAgentBinary(proc(1, 0, 1, 'node.exe C:\\proj\\node_modules\\vite\\bin\\vite.js'))).toBe(false);
      expect(argsContainAgentBinary(proc(1, 0, 1, 'node.exe C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\vendor\\helper.js'))).toBe(false);
      expect(argsContainAgentBinary(proc(1, 0, 1, 'cmd.exe /c echo claude-code'))).toBe(false);
    });
  });
});

describe('findAgentProcessTypes', () => {
  it('tells claude from codex for a native Windows binary and for an npm script', () => {
    const entries = [
      proc(10, 1, 9, 'cmd.exe'),
      proc(11, 10, 8, '"C:\\x\\claude.exe"'),
      proc(20, 1, 9, 'cmd.exe'),
      proc(21, 20, 8, 'node.exe C:\\n\\node_modules\\@openai\\codex\\bin\\codex.js'),
    ];
    expect([...findAgentProcessTypes(entries, 10)]).toEqual(['claude']);
    expect([...findAgentProcessTypes(entries, 20)]).toEqual(['codex']);
  });
});

describe('isAgentProcessRunning', () => {
  it('detects claude running as a grandchild process (shebang-launched node wrapper in between)', () => {
    const entries = [
      proc(100, 1, 60, 'node /path/to/azito-supervisor.cjs -- claude --dangerously-skip-permissions'),
      proc(200, 100, 55, 'node /path/to/some-wrapper.js'),
      proc(300, 200, 50, 'claude --dangerously-skip-permissions --model claude-opus-4-6[1m]'),
    ];
    expect(isAgentProcessRunning(entries, 100)).toBe(true);
  });

  it('returns false when the process tree runs node but no descendant args reference claude/codex', () => {
    const entries = [
      proc(100, 1, 60, 'node /path/to/some-other-script.js --flag value'),
      proc(200, 100, 55, '/bin/bash -c "npm run build"'),
    ];
    expect(isAgentProcessRunning(entries, 100)).toBe(false);
  });

  it('detects codex when the codex binary is invoked directly as the root process', () => {
    const entries = [proc(500, 1, 10, '/opt/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex --dangerously-bypass-approvals-and-sandbox')];
    expect(isAgentProcessRunning(entries, 500)).toBe(true);
  });

  it('returns false when the root pid is not present in the snapshot', () => {
    expect(isAgentProcessRunning([proc(1, 0, 999999, '/sbin/init')], 999)).toBe(false);
  });

  it('ignores a process whose ppid names a reused pid: it started before that "parent", so it is not its child', () => {
    // pid 10 (a pane shell) is new; pid 99 claude.exe is an orphan of an earlier process that had pid 10.
    const entries = [proc(10, 1, 5, 'cmd.exe'), proc(99, 10, 600, 'claude.exe --resume abc')];
    expect(isAgentProcessRunning(entries, 10)).toBe(false);
    expect(findAgentProcessStartMs(entries, 10)).toBeNull();
    expect(findAgentProcessTypes(entries, 10).size).toBe(0);
  });

  it('keeps the edge when either start time is unknown', () => {
    const entries: ProcessEntry[] = [{ ...proc(10, 1, 5, 'cmd.exe'), startMs: null }, proc(99, 10, 600, 'claude.exe')];
    expect(isAgentProcessRunning(entries, 10)).toBe(true);
  });

  it('terminates when the parent links form a loop (a reused pid)', () => {
    const entries = [proc(10, 11, 5, 'cmd.exe'), proc(11, 10, 5, 'node.exe x.js')];
    expect(isAgentProcessRunning(entries, 10)).toBe(false);
  });
});

describe('findAgentProcessStartMs', () => {
  it('returns the start time of the matched descendant process', () => {
    const entries = [
      proc(100, 1, 90, 'node /path/to/some-wrapper.js'),
      proc(300, 100, 42, 'claude --dangerously-skip-permissions --model claude-opus-4-6[1m]'),
    ];
    expect(findAgentProcessStartMs(entries, 100)).toBe(NOW - 42 * 1000);
  });

  it('picks the earliest-started match when multiple descendants reference an agent binary (Issue #338 follow-up: a later-spawned short-lived helper must not push the baseline forward)', () => {
    const entries = [
      proc(100, 1, 90, 'node /path/to/wrapper.js'),
      proc(200, 100, 80, 'claude --resume abc'),
      proc(201, 100, 5, 'claude --dangerously-skip-permissions'),
    ];
    expect(findAgentProcessStartMs(entries, 100)).toBe(NOW - 80 * 1000);
  });

  it('ignores a matching process whose start time the host does not report', () => {
    const entries: ProcessEntry[] = [
      proc(100, 1, 90, 'cmd.exe'),
      { ...proc(200, 100, 0, 'claude.exe'), startMs: null },
    ];
    expect(findAgentProcessStartMs(entries, 100)).toBeNull();
  });

  it('returns null when no descendant references claude/codex', () => {
    expect(findAgentProcessStartMs([proc(100, 1, 60, 'node /path/to/some-other-script.js')], 100)).toBeNull();
  });

  it('returns null when the root pid is not present in the snapshot', () => {
    expect(findAgentProcessStartMs([proc(1, 0, 999999, '/sbin/init')], 999)).toBeNull();
  });
});

describe('argsContainSessionId', () => {
  const SESSION_ID = '019fea40-1234-7abc-8def-0123456789ab';

  it('matches a session id passed as a `codex resume <id>` argument on a descendant process', () => {
    const entries = [
      proc(9000, 1, 50, 'node /path/to/azito-supervisor.cjs -- codex resume ' + SESSION_ID),
      proc(9001, 9000, 9, '/opt/codex/bin/codex resume ' + SESSION_ID),
    ];
    expect(argsContainSessionId(entries, [9000], SESSION_ID)).toBe(true);
  });

  it('matches a session id passed as a `claude --resume <id>` argument', () => {
    expect(argsContainSessionId([proc(300, 1, 10, 'claude --resume ' + SESSION_ID)], [300], SESSION_ID)).toBe(true);
  });

  it('matches a session id on a Windows command line with a quoted program path', () => {
    expect(argsContainSessionId([proc(300, 1, 10, `"C:\\Program Files\\x\\claude.exe" --resume ${SESSION_ID}`)], [300], SESSION_ID)).toBe(true);
  });

  it('does not match when the session id only appears as a substring of another token', () => {
    expect(argsContainSessionId([proc(300, 1, 10, `claude --resume ${SESSION_ID}-not-the-same`)], [300], SESSION_ID)).toBe(false);
  });

  it('returns false when no rootPid is present in the snapshot', () => {
    expect(argsContainSessionId([proc(1, 0, 999999, '/sbin/init')], [999], SESSION_ID)).toBe(false);
  });

  it('returns false for an empty sessionId', () => {
    expect(argsContainSessionId([proc(300, 1, 10, 'claude --resume ' + SESSION_ID)], [300], '')).toBe(false);
  });
});
