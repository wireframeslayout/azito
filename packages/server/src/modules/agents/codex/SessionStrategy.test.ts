import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { CodexSessionStrategy } from './SessionStrategy';
import { posixDialect } from '../../../shared/os/shellDialect';
import { renderLaunchLine } from '../WorkerLaunch';
import { LocalFileOps, localFileOpsHost } from '../../../shared/fs/LocalFileOps';

const server: ServerConfig = {
  name: 'local',
  type: 'local',
  host: null,
  agentPort: null,
  agentToken: null,
  agentVersion: null,
  sshHost: null,
  defaultMux: 'tmux' as const, muxRuntime: 'system',
  hostProfile: null, sshHostFingerprint: null,
  isolationIntent: false,
  isolationVerifiedAt: null,
  isolationReport: null, isolationCleanupReport: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

let home: string;
let nextMtime: number;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'azito-codex-sessions-')));
  nextMtime = 1_000_000;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A strategy over the real files of a temporary home directory (the hub's own host: LocalFileOps). */
function createStrategy(codexHome: string | null = null): CodexSessionStrategy {
  const ops = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: home }));
  const transportFactory = { getFileOps: () => ops } as unknown as TransportFactory;
  return new CodexSessionStrategy(transportFactory, { claudeConfigDir: null, codexHome });
}

/** Writes a rollout file under ~/.codex/sessions; each call is newer than the one before. Returns its path. */
function rollout(name: string, firstLine: string, options: { mtime?: number } = {}): string {
  const full = path.join(home, '.codex', 'sessions', '2026', '07', '15', name);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, `${firstLine}\n{"type":"event_msg","payload":{"session_id":"from-a-later-line"}}\n`);
  const mtime = options.mtime ?? (nextMtime += 10);
  utimesSync(full, mtime, mtime);
  return full;
}

function meta(sessionId: string, cwd: string | null, originator: string | null): string {
  return JSON.stringify({ type: 'session_meta', payload: { session_id: sessionId, cwd, originator } });
}

/** The line the respawn launch is typed as. */
function respawnLine(strategy: CodexSessionStrategy, sessionId: string | null, model: string | null, extraArgs: string | null, blockMcp = true): string {
  return renderLaunchLine(strategy.buildRespawnLaunch(sessionId, model, extraArgs, blockMcp), posixDialect);
}

describe('CodexSessionStrategy.buildRespawnLaunch (Issue #28 third-party review: respawn MCP-bypass fix)', () => {
  it('includes the azt-mcp disable override on a resume respawn, same as a fresh launch', () => {
    const strategy = createStrategy();
    const fresh = respawnLine(strategy, null, null, null);
    const resumed = respawnLine(strategy, 'session-1', null, null);
    expect(fresh).toContain('-c mcp_servers.azt-mcp.enabled=false -c mcp_servers.azt-mcp.command=azt-mcp-disabled');
    // This is the exact gap the review caught: the respawn builder's
    // `codex resume` branch previously hand-rolled its own command string
    // and omitted the MCP-disable override that buildCodexLaunchCommand
    // applies to a fresh launch — a respawned codex worker could load the
    // operator's azt-mcp (full-power AZITO_UI_TOKEN) and bypass task-token
    // scoping.
    expect(resumed).toContain('-c mcp_servers.azt-mcp.enabled=false -c mcp_servers.azt-mcp.command=azt-mcp-disabled');
    expect(resumed).toBe(
      'codex resume session-1 --dangerously-bypass-approvals-and-sandbox -c mcp_servers.azt-mcp.enabled=false -c mcp_servers.azt-mcp.command=azt-mcp-disabled',
    );
  });

  it('forwards model and extraArgs on a resume respawn, same as a fresh launch', () => {
    const strategy = createStrategy();
    const resumed = respawnLine(strategy, 'session-2', 'gpt-5.6-sol', '--verbose');
    expect(resumed).toBe(
      "codex resume session-2 --dangerously-bypass-approvals-and-sandbox -c mcp_servers.azt-mcp.enabled=false -c mcp_servers.azt-mcp.command=azt-mcp-disabled --model 'gpt-5.6-sol' '--verbose'",
    );
  });

  it('omits MCP disable flag when blockMcp is false (Issue #471)', () => {
    const strategy = createStrategy();
    const fresh = respawnLine(strategy, null, null, null, false);
    expect(fresh).not.toContain('mcp_servers.azt-mcp.enabled=false');
    expect(fresh).toBe('codex --dangerously-bypass-approvals-and-sandbox');
  });

  it('omits MCP disable flag on resume when blockMcp is false', () => {
    const strategy = createStrategy();
    const resumed = respawnLine(strategy, 'session-3', null, null, false);
    expect(resumed).not.toContain('mcp_servers.azt-mcp.enabled=false');
    expect(resumed).toBe('codex resume session-3 --dangerously-bypass-approvals-and-sandbox');
  });
});

describe('CodexSessionStrategy.scanSessionId', () => {
  it('reads CODEX_HOME/sessions on the hub\'s own server, and ~/.codex/sessions on any other', async () => {
    const codexHome = path.join(home, 'custom-codex');
    const full = path.join(codexHome, 'sessions', '2026', '07', '15', 'rollout-1.jsonl');
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, `${meta('from-codex-home', '/work', 'codex')}\n`);
    utimesSync(full, 1_000_010, 1_000_010);

    await expect(createStrategy(codexHome).scanSessionId(server, '/work')).resolves.toBe('from-codex-home');
    await expect(createStrategy(codexHome).scanSessionId({ ...server, type: 'agent' }, '/work')).resolves.toBeNull();
    await expect(createStrategy().scanSessionId(server, '/work')).resolves.toBeNull();
  });

  it('returns a session with a matching cwd', async () => {
    rollout('rollout-1.jsonl', meta('session-1', '/work', 'codex'));
    await expect(createStrategy().scanSessionId(server, '/work')).resolves.toBe('session-1');
  });

  it('excludes a mismatched cwd', async () => {
    rollout('rollout-1.jsonl', meta('session-1', '/other', 'codex'));
    await expect(createStrategy().scanSessionId(server, '/work')).resolves.toBeNull();
  });

  it('excludes codex_exec sessions', async () => {
    rollout('rollout-1.jsonl', meta('session-1', '/work', 'codex_exec'));
    await expect(createStrategy().scanSessionId(server, '/work')).resolves.toBeNull();
  });

  it('selects the oldest candidate after filtering', async () => {
    rollout('rollout-new.jsonl', meta('new', '/work', 'codex'));
    rollout('rollout-old.jsonl', meta('old', '/work', 'codex'), { mtime: 500_000 });
    await expect(createStrategy().scanSessionId(server, '/work')).resolves.toBe('old');
  });

  it('skips cwd filtering when workingDirectory is null', async () => {
    rollout('rollout-other.jsonl', meta('other', '/other', 'codex'));
    rollout('rollout-exec.jsonl', meta('exec', '/work', 'codex_exec'));
    await expect(createStrategy().scanSessionId(server, null)).resolves.toBe('other');
  });

  it('normalizes trailing slashes before comparing cwd', async () => {
    rollout('rollout-1.jsonl', meta('session-1', '/work/', 'codex'));
    await expect(createStrategy().scanSessionId(server, '/work///')).resolves.toBe('session-1');
  });

  it('skips candidates with invalid session metadata', async () => {
    rollout('rollout-bad.jsonl', 'not json');
    await expect(createStrategy().scanSessionId(server, '/work')).resolves.toBeNull();
  });

  it('skips excluded session IDs and returns the next candidate', async () => {
    rollout('rollout-old.jsonl', meta('assigned', '/work', 'codex'), { mtime: 500_000 });
    rollout('rollout-new.jsonl', meta('unassigned', '/work', 'codex'));
    const strategy = createStrategy();
    strategy.excludeSessionId('assigned');
    await expect(strategy.scanSessionId(server, '/work')).resolves.toBe('unassigned');
  });

  it('reads the metadata from the first line only, and only from rollout-*.jsonl files', async () => {
    rollout('rollout-1.jsonl', meta('first-line', '/work', 'codex'));
    rollout('other.jsonl', meta('not-a-rollout', '/work', 'codex'), { mtime: 400_000 });
    rollout('rollout-2.txt', meta('wrong-extension', '/work', 'codex'), { mtime: 400_000 });
    await expect(createStrategy().scanSessionId(server, '/work')).resolves.toBe('first-line');
  });

  it('considers only rollouts newer than the timestamp', async () => {
    rollout('rollout-before.jsonl', meta('before', '/work', 'codex'), { mtime: 1000 });
    rollout('rollout-after.jsonl', meta('after', '/work', 'codex'), { mtime: 3000 });
    await expect(createStrategy().scanSessionId(server, '/work', new Date(2_000_000))).resolves.toBe('after');
  });

  it('is null when there is no sessions directory', async () => {
    await expect(createStrategy().scanSessionId(server, '/work')).resolves.toBeNull();
  });
});
