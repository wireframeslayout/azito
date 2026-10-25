import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { LocalFileOps, localFileOpsHost } from '../../../shared/fs/LocalFileOps';
import { ClaudeSessionStrategy } from './SessionStrategy';
import { posixDialect } from '../../../shared/os/shellDialect';
import { launchArgv, renderLaunchLine } from '../WorkerLaunch';

const server = { name: 'local', type: 'local' } as unknown as ServerConfig;

const SESSION_ID = '71f25140-240d-4720-a01c-3888b3732806';
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

let home: string;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'azito-claude-sessions-')));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A strategy over the real files of a temporary home directory (the hub's own host: LocalFileOps). */
function createStrategy(claudeConfigDir: string | null = null): ClaudeSessionStrategy {
  const ops = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: home }));
  return new ClaudeSessionStrategy({ getFileOps: () => ops } as unknown as TransportFactory, { claudeConfigDir, codexHome: null });
}

/** A session file under ~/.claude/projects/<encoded working directory>/. */
function session(encodedDir: string, name: string, mtimeSeconds: number): void {
  const full = path.join(home, '.claude', 'projects', encodedDir, name);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, '{}\n');
  utimesSync(full, mtimeSeconds, mtimeSeconds);
}

describe('ClaudeSessionStrategy.scanSessionId', () => {
  it('returns the id of the newest session file of the working directory (slashes and dots become dashes)', async () => {
    session('-work-my-app', `${SESSION_A}.jsonl`, 1000);
    session('-work-my-app', `${SESSION_B}.jsonl`, 2000);
    session('-work-other', '33333333-3333-4333-8333-333333333333.jsonl', 3000);

    await expect(createStrategy().scanSessionId(server, '/work/my.app')).resolves.toBe(SESSION_B);
  });

  it('encodes the working directory by Claude Code\'s rule (every non-alphanumeric character becomes a dash)', async () => {
    session('-work-my-app-1-', `${SESSION_A}.jsonl`, 1000);

    await expect(createStrategy().scanSessionId(server, '/work/my_app 1日')).resolves.toBe(SESSION_A);
  });

  it('reads CLAUDE_CONFIG_DIR/projects on the hub\'s own server, and ~/.claude/projects on any other', async () => {
    const configDir = path.join(home, 'custom-claude');
    const full = path.join(configDir, 'projects', '-work-app', `${SESSION_B}.jsonl`);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, '{}\n');
    session('-work-app', `${SESSION_A}.jsonl`, 1000);

    await expect(createStrategy(configDir).scanSessionId(server, '/work/app')).resolves.toBe(SESSION_B);
    await expect(createStrategy(configDir).scanSessionId({ ...server, type: 'agent' } as ServerConfig, '/work/app')).resolves.toBe(SESSION_A);
    await expect(createStrategy().scanSessionId(server, '/work/app')).resolves.toBe(SESSION_A);
  });

  it('finds a session under the uncut name (Claude Code 2.0.x) for a working directory over 200 characters', async () => {
    const long = `/${'a'.repeat(249)}`;
    session(`-${'a'.repeat(249)}`, `${SESSION_A}.jsonl`, 1000);

    await expect(createStrategy().scanSessionId(server, long)).resolves.toBe(SESSION_A);
  });

  it('takes the newest of the cut-name and uncut-name directories', async () => {
    const long = `/${'a'.repeat(249)}`;
    session(`-${'a'.repeat(249)}`, `${SESSION_A}.jsonl`, 1000);
    session(`-${'a'.repeat(199)}-wkpu26`, `${SESSION_B}.jsonl`, 2000);

    await expect(createStrategy().scanSessionId(server, long)).resolves.toBe(SESSION_B);
  });

  it('ignores a trailing slash of the working directory', async () => {
    session('-work-app', `${SESSION_A}.jsonl`, 1000);

    await expect(createStrategy().scanSessionId(server, '/work/app//')).resolves.toBe(SESSION_A);
  });

  it('considers only files newer than the timestamp', async () => {
    session('-work-app', `${SESSION_A}.jsonl`, 1000);
    session('-work-app', `${SESSION_B}.jsonl`, 3000);

    await expect(createStrategy().scanSessionId(server, '/work/app', new Date(2_000_000))).resolves.toBe(SESSION_B);
    await expect(createStrategy().scanSessionId(server, '/work/app', new Date(4_000_000))).resolves.toBeNull();
  });

  it('is null for a file whose name is not a session id, for no sessions, and without a working directory', async () => {
    session('-work-app', 'notes.jsonl', 1000);

    await expect(createStrategy().scanSessionId(server, '/work/app')).resolves.toBeNull();
    await expect(createStrategy().scanSessionId(server, '/work/none')).resolves.toBeNull();
    await expect(createStrategy().scanSessionId(server, null)).resolves.toBeNull();
  });
});

/** The line the respawn launch is typed as. */
function respawnLine(strategy: ClaudeSessionStrategy, sessionId: string | null, model: string | null, extraArgs: string | null, blockMcp = true): string {
  return renderLaunchLine(strategy.buildRespawnLaunch(sessionId, model, extraArgs, blockMcp), posixDialect);
}

describe('ClaudeSessionStrategy', () => {
  const strategy = new ClaudeSessionStrategy({} as TransportFactory, { claudeConfigDir: null, codexHome: null });

  it('starts a new session with --session-id', () => {
    expect(strategy.buildNewSessionArgs(SESSION_ID)).toEqual(['--session-id', SESSION_ID]);
  });

  it('resumes with --resume <id> and never combines --session-id with --resume', () => {
    const flags = strategy.buildResumeArgs(SESSION_ID);
    expect(flags).toEqual(['--resume', SESSION_ID]);
    // Claude Code rejects `--session-id` together with `--resume` unless
    // `--fork-session` is also given, so the follow-up relaunch would exit.
    expect(flags).not.toContain('--session-id');
  });

  it('builds the respawn command with --resume <id>', () => {
    const cmd = respawnLine(strategy, SESSION_ID, 'claude-opus-4-6[1m]', null);
    expect(cmd).toContain(`--resume ${SESSION_ID}`);
    expect(cmd).not.toContain('--session-id');
  });

  it('a resumed launch carries extraArgs in the line as the user wrote it (quotes and spacing kept), as it always has; a fresh one quotes each word', () => {
    expect(respawnLine(strategy, SESSION_ID, 'sonnet', "--append-system-prompt 'a  b'")).toBe(
      `claude --resume ${SESSION_ID} --dangerously-skip-permissions --strict-mcp-config --model 'sonnet' --append-system-prompt 'a  b'`,
    );
    expect(respawnLine(strategy, null, 'sonnet', '--verbose --x')).toBe(
      "claude --dangerously-skip-permissions --strict-mcp-config --model 'sonnet' '--verbose' '--x'",
    );
    // For a host that starts the program itself, the same text is split into words.
    expect(launchArgv(strategy.buildRespawnLaunch(SESSION_ID, null, '--verbose --x'))).toEqual(
      ['claude', '--resume', SESSION_ID, '--dangerously-skip-permissions', '--strict-mcp-config', '--verbose', '--x'],
    );
  });

  it('includes --strict-mcp-config by default', () => {
    const cmd = respawnLine(strategy, SESSION_ID, null, null);
    expect(cmd).toContain('--strict-mcp-config');
  });

  it('omits --strict-mcp-config when blockMcp is false (Issue #471)', () => {
    const cmd = respawnLine(strategy, SESSION_ID, null, null, false);
    expect(cmd).not.toContain('--strict-mcp-config');
    expect(cmd).toContain(`--resume ${SESSION_ID}`);
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  it('omits --strict-mcp-config for fresh launch when blockMcp is false', () => {
    const cmd = respawnLine(strategy, null, null, null, false);
    expect(cmd).not.toContain('--strict-mcp-config');
    expect(cmd).toBe('claude --dangerously-skip-permissions');
  });
});
