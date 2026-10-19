import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { LocalFileOps, localFileOpsHost } from '../../../shared/fs/LocalFileOps';
import { ClaudeSessionStrategy } from './SessionStrategy';

const server = { name: 'local', type: 'local' } as unknown as ServerConfig;

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
function createStrategy(): ClaudeSessionStrategy {
  const ops = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: home }));
  return new ClaudeSessionStrategy({ getFileOps: () => ops } as unknown as TransportFactory);
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

  it('includes --strict-mcp-config by default', () => {
    const cmd = strategy.buildRespawnCommand(SESSION_ID, null, null, posixDialect);
    expect(cmd).toContain('--strict-mcp-config');
  });

  it('omits --strict-mcp-config when blockMcp is false (Issue #471)', () => {
    const cmd = strategy.buildRespawnCommand(SESSION_ID, null, null, posixDialect, false);
    expect(cmd).not.toContain('--strict-mcp-config');
    expect(cmd).toContain(`--resume ${SESSION_ID}`);
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  it('omits --strict-mcp-config for fresh launch when blockMcp is false', () => {
    const cmd = strategy.buildRespawnCommand(null, null, null, posixDialect, false);
    expect(cmd).not.toContain('--strict-mcp-config');
    expect(cmd).toBe('claude --dangerously-skip-permissions');
  });
});
