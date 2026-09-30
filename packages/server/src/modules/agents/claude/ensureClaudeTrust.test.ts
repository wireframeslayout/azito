import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { ensureClaudeTrust } from './ensureClaudeTrust';

let fakeHome: string;

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

const transportStub = {} as IServerTransport;
const configPath = (): string => join(fakeHome, '.claude.json');
const readConfig = (): { projects: Record<string, Record<string, unknown>> } =>
  JSON.parse(readFileSync(configPath(), 'utf8'));

describe('ensureClaudeTrust (local)', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'claude-trust-'));
  });
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('registers trust for a new project', async () => {
    writeFileSync(configPath(), JSON.stringify({ projects: {} }));
    expect(await ensureClaudeTrust('local', transportStub, '/wt')).toEqual({ action: 'registered' });
    expect(readConfig().projects['/wt']).toEqual({ hasTrustDialogAccepted: true });
    expect(readdirSync(fakeHome)).toEqual(['.claude.json']);
  });

  it('returns already_trusted without rewriting', async () => {
    const original = JSON.stringify({ projects: { '/wt': { hasTrustDialogAccepted: true } } });
    writeFileSync(configPath(), original);
    expect(await ensureClaudeTrust('local', transportStub, '/wt')).toEqual({ action: 'already_trusted' });
    expect(readFileSync(configPath(), 'utf8')).toBe(original);
  });

  it('returns failed for invalid JSON', async () => {
    writeFileSync(configPath(), '{not json');
    const result = await ensureClaudeTrust('local', transportStub, '/wt');
    expect(result.action).toBe('failed');
  });

  it('returns skipped when the file does not exist', async () => {
    expect(await ensureClaudeTrust('local', transportStub, '/wt')).toEqual({
      action: 'skipped',
      reason: '~/.claude.json not found',
    });
  });

  it('preserves existing fields and other projects', async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        numStartups: 3,
        projects: { '/wt': { allowedTools: ['Bash'], hasTrustDialogAccepted: false }, '/other': { x: 1 } },
      }),
    );
    expect(await ensureClaudeTrust('local', transportStub, '/wt')).toEqual({ action: 'registered' });
    const config = readConfig() as unknown as { numStartups: number; projects: Record<string, unknown> };
    expect(config.numStartups).toBe(3);
    expect(config.projects['/other']).toEqual({ x: 1 });
    expect(config.projects['/wt']).toEqual({ allowedTools: ['Bash'], hasTrustDialogAccepted: true });
  });
});

describe('ensureClaudeTrust (remote)', () => {
  function transportWithStdout(stdout: string): { transport: IServerTransport; exec: ReturnType<typeof vi.fn> } {
    const exec = vi.fn().mockResolvedValue({ stdout, stderr: '', code: 0 });
    return { transport: { exec } as unknown as IServerTransport, exec };
  }

  it('runs node with the shell-quoted path and reports registered', async () => {
    const { transport, exec } = transportWithStdout('REGISTERED\n');
    expect(await ensureClaudeTrust('ssh', transport, "/home/u/it's wt")).toEqual({ action: 'registered' });
    const command = exec.mock.calls[0][0] as string;
    expect(command).toContain('node -e ');
    expect(command).toContain("'/home/u/it'\\''s wt'");
    expect(command).toContain('hasTrustDialogAccepted');
  });

  it('reports already_trusted', async () => {
    const { transport } = transportWithStdout('TRUSTED\n');
    expect(await ensureClaudeTrust('ssh', transport, '/wt')).toEqual({ action: 'already_trusted' });
  });

  it('returns skipped when remote JSON is missing or invalid', async () => {
    const { transport } = transportWithStdout('NOJSON\n');
    expect((await ensureClaudeTrust('agent', transport, '/wt')).action).toBe('skipped');
  });

  it('returns failed on unexpected output', async () => {
    const { transport } = transportWithStdout('node: command not found');
    expect((await ensureClaudeTrust('ssh', transport, '/wt')).action).toBe('failed');
  });
});
