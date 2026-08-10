import { describe, it, expect } from 'vitest';
import { parsePsOutput, argsContainAgentBinary, isAgentProcessRunning } from './agentProcessDetection';
import type { PsEntry } from './agentProcessDetection';

describe('parsePsOutput', () => {
  it('parses pid/ppid/args lines with leading whitespace (ps -e -o pid=,ppid=,args= format)', () => {
    const output = [
      '  59026   58986 claude --dangerously-skip-permissions --model claude-opus-4-6[1m]',
      '     1       0 /sbin/init',
    ].join('\n');
    expect(parsePsOutput(output)).toEqual<PsEntry[]>([
      { pid: 59026, ppid: 58986, args: 'claude --dangerously-skip-permissions --model claude-opus-4-6[1m]' },
      { pid: 1, ppid: 0, args: '/sbin/init' },
    ]);
  });

  it('skips blank lines and malformed rows', () => {
    const output = ['', '  not a valid line', '  123   1 bash'].join('\n');
    expect(parsePsOutput(output)).toEqual<PsEntry[]>([{ pid: 123, ppid: 1, args: 'bash' }]);
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
      { pid: 100, ppid: 1, args: 'node /path/to/azito-supervisor.cjs -- claude --dangerously-skip-permissions' },
      { pid: 200, ppid: 100, args: 'node /path/to/some-wrapper.js' },
      { pid: 300, ppid: 200, args: 'claude --dangerously-skip-permissions --model claude-opus-4-6[1m]' },
    ];
    expect(isAgentProcessRunning(entries, 100)).toBe(true);
  });

  it('returns false when the process tree runs node but no descendant args reference claude/codex', () => {
    const entries: PsEntry[] = [
      { pid: 100, ppid: 1, args: 'node /path/to/some-other-script.js --flag value' },
      { pid: 200, ppid: 100, args: '/bin/bash -c "npm run build"' },
    ];
    expect(isAgentProcessRunning(entries, 100)).toBe(false);
  });

  it('detects codex when the codex binary is invoked directly as the root process', () => {
    const entries: PsEntry[] = [
      { pid: 500, ppid: 1, args: '/opt/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex --dangerously-bypass-approvals-and-sandbox' },
    ];
    expect(isAgentProcessRunning(entries, 500)).toBe(true);
  });

  it('returns false when the root pid is not present in the ps snapshot', () => {
    const entries: PsEntry[] = [{ pid: 1, ppid: 0, args: '/sbin/init' }];
    expect(isAgentProcessRunning(entries, 999)).toBe(false);
  });
});
