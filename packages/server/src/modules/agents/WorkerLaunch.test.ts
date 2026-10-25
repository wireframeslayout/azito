import { describe, it, expect } from 'vitest';
import { HostProfileError } from '../../shared/os/hostProfile';
import { posixDialect, powershellDialect } from '../../shared/os/shellDialect';
import { buildWorkerLaunch } from './LaunchCommand';
import { commandLineLaunch, flag, launchArgv, renderLaunchLine, splitCommandLine, value, withFlags, type ProgramLaunch } from './WorkerLaunch';

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

  it('a generic command is typed as written on POSIX and split into words for a program', () => {
    const launch = buildWorkerLaunch('generic', null, 'my-custom-tool --flag');
    expect(renderLaunchLine(launch!, posixDialect)).toBe('my-custom-tool --flag');
    expect(launchArgv(launch!)).toEqual(['my-custom-tool', '--flag']);
    expect(buildWorkerLaunch('generic', null, null)).toBeNull();
    expect(buildWorkerLaunch('unknown-tool', null, '   ')).toBeNull();
    expect(buildWorkerLaunch(null, null, 'some-cmd')).toEqual(commandLineLaunch('some-cmd'));
  });

});

describe('launchArgv for cmd.exe (a .cmd shim reads its arguments again)', () => {
  it.each(['%', '^', '&', '|', '<', '>', '"', '!', '(', ')'])('refuses a word with %s, whoever quoted it', (ch) => {
    expect(() => launchArgv(buildWorkerLaunch('claude', `a${ch}b`, null)!)).toThrowError(expect.objectContaining({ code: 'unsupported_os' }));
    expect(() => launchArgv(buildWorkerLaunch('codex', null, `--x a${ch}b`)!)).toThrow(HostProfileError);
  });

  it("refuses a launch-agent command whose single quoted word has one: `claude --model 'a&b'`", () => {
    expect(() => launchArgv(commandLineLaunch("claude --model 'a&b'"))).toThrowError(expect.objectContaining({ code: 'unsupported_os' }));
    expect(() => launchArgv(commandLineLaunch("claude --model '%PATH%'"))).toThrow(HostProfileError);
  });

  it("refuses a Unit's workerExtraArgs with a percent sign", () => {
    expect(() => launchArgv(buildWorkerLaunch('claude', 'sonnet', '--append-system-prompt 100%')!)).toThrow(/cmd\.exe/);
  });

  it('accepts the words claude and codex are really started with', () => {
    expect(launchArgv(buildWorkerLaunch('claude', 'claude-opus-4-6[1m]', '--verbose')!)).toContain('claude-opus-4-6[1m]');
    expect(launchArgv(buildWorkerLaunch('codex', null, null)!)).toContain('mcp_servers.azt-mcp.enabled=false');
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
