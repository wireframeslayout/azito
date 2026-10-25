import { describe, it, expect } from 'vitest';
import { HostProfileError } from '../../shared/os/hostProfile';
import { posixDialect, powershellDialect } from '../../shared/os/shellDialect';
import { buildWorkerLaunch } from './LaunchCommand';
import { commandLineLaunch, flag, launchArgv, launchEnv, launchProgramName, renderLaunchLine, splitCommandLine, value, withFlags, type ProgramLaunch } from './WorkerLaunch';

describe('one launch, two ways to start it', () => {
  it('claude: a POSIX line and a Windows argv from the same definition', () => {
    const launch = buildWorkerLaunch('claude', 'claude-opus-4-6[1m]', "--verbose it's");
    expect(renderLaunchLine(launch!, posixDialect)).toBe(
      "claude --dangerously-skip-permissions --strict-mcp-config --model 'claude-opus-4-6[1m]' '--verbose' 'it'\\''s'",
    );
    expect(launchArgv(launch!)).toEqual([
      'claude', '--dangerously-skip-permissions', '--strict-mcp-config', '--model', 'claude-opus-4-6[1m]', '--verbose', "it's",
    ]);
  });

  it('codex: the same, with the MCP override as two words', () => {
    const launch = buildWorkerLaunch('codex', 'gpt-5.6-sol', null);
    expect(renderLaunchLine(launch!, posixDialect)).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox -c mcp_servers.azt-mcp.enabled=false --model 'gpt-5.6-sol'",
    );
    expect(launchArgv(launch!)).toEqual([
      'codex', '--dangerously-bypass-approvals-and-sandbox', '-c', 'mcp_servers.azt-mcp.enabled=false', '--model', 'gpt-5.6-sol',
    ]);
  });

  it('session arguments are added after the launch in both forms', () => {
    const launch = withFlags(buildWorkerLaunch('claude', null, null)!, ['--session-id', 's-1']);
    expect(renderLaunchLine(launch, posixDialect)).toBe('claude --dangerously-skip-permissions --strict-mcp-config --session-id s-1');
    expect(launchArgv(launch)).toEqual(['claude', '--dangerously-skip-permissions', '--strict-mcp-config', '--session-id', 's-1']);
    expect(withFlags(commandLineLaunch('my-tool --x'), ['--session-id', 's-1'])).toEqual(commandLineLaunch('my-tool --x --session-id s-1'));
    const bare = buildWorkerLaunch('claude', null, null)!;
    expect(withFlags(bare, [])).toBe(bare);
  });

  it('a value is quoted in the shell the line is typed into, a flag is not', () => {
    const launch: ProgramLaunch = { kind: 'program', file: 'tool', args: [flag('--model'), value("o'brien")] };
    expect(renderLaunchLine(launch, posixDialect)).toBe("tool --model 'o'\\''brien'");
    expect(renderLaunchLine(launch, powershellDialect)).toBe("tool --model 'o''brien'");
  });

  it('a program with an env writes it before the program in a line, and hands it to the mux separately', () => {
    const launch: ProgramLaunch = { kind: 'program', file: 'tool', args: [flag('--x')], env: { A: '1' } };
    expect(renderLaunchLine(launch, posixDialect)).toBe("A='1' tool --x");
    expect(launchEnv(launch)).toEqual({ A: '1' });
    expect(launchEnv(commandLineLaunch('tool'))).toEqual({});
    expect(launchEnv({ kind: 'program', file: 'tool', args: [] })).toEqual({});
  });

  it('a generic command is typed as written on POSIX and split into words for a program', () => {
    const launch = buildWorkerLaunch('generic', null, 'my-custom-tool --flag');
    expect(renderLaunchLine(launch!, posixDialect)).toBe('my-custom-tool --flag');
    expect(launchArgv(launch!)).toEqual(['my-custom-tool', '--flag']);
    expect(buildWorkerLaunch('generic', null, null)).toBeNull();
    expect(buildWorkerLaunch('unknown-tool', null, '   ')).toBeNull();
    expect(buildWorkerLaunch(null, null, 'some-cmd')).toEqual(commandLineLaunch('some-cmd'));
  });

  it('names the program that is started', () => {
    expect(launchProgramName(buildWorkerLaunch('claude', null, null)!)).toBe('claude');
    expect(launchProgramName(commandLineLaunch('C:\\tools\\agent.cmd --x'))).toBe('agent');
    expect(launchProgramName(commandLineLaunch('/usr/bin/some-generic-tool'))).toBe('some-generic-tool');
  });
});

describe('splitCommandLine', () => {
  it('splits plain words and single quoted words, as the Add Window form writes them', () => {
    expect(splitCommandLine("claude --dangerously-skip-permissions --model 'claude-opus-4-6[1m]'")).toEqual(['claude', '--dangerously-skip-permissions', '--model', 'claude-opus-4-6[1m]']);
    expect(splitCommandLine("  tool\t'a  b'   ''  x'y z'w ")).toEqual(['tool', 'a  b', '', 'xy zw']);
    expect(splitCommandLine('C:\\tools\\agent.exe --dir C:\\work')).toEqual(['C:\\tools\\agent.exe', '--dir', 'C:\\work']);
  });

  it.each([
    ['a double quote', 'tool "a b"'],
    ['a pipe', 'tool | cat'],
    ['a semicolon', 'tool; other'],
    ['an ampersand', 'tool && other'],
    ['a variable', 'tool $HOME'],
    ['a command substitution', 'tool $(id)'],
    ['a backquote', 'tool `id`'],
    ['a redirect', 'tool > out'],
    ['a percent variable', 'tool %PATH%'],
    ['a caret', 'tool ^x'],
    ['a newline', 'tool\nother'],
    ['an escaped quote', "tool 'a'\\''b'"],
    ['an unterminated quote', "tool 'a b"],
    ['nothing', '   '],
  ])('refuses %s: guessing its meaning would start a different command', (_name, line) => {
    expect(() => splitCommandLine(line)).toThrowError(expect.objectContaining({ code: 'unsupported_os' }));
    expect(() => splitCommandLine(line)).toThrow(HostProfileError);
  });

  it('keeps shell syntax inside single quotes as plain text', () => {
    expect(splitCommandLine("tool '$HOME | x; y'")).toEqual(['tool', '$HOME | x; y']);
  });
});
