import { EventEmitter } from 'events';
import * as fs from 'fs';
import { PassThrough } from 'stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { CodexExecClient } from './CodexExecClient';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    mkdtempSync: vi.fn(),
    createReadStream: vi.fn(),
  };
});

function createFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stderr: EventEmitter;
  };
  proc.stdin = new PassThrough();
  proc.stderr = new EventEmitter();
  return proc;
}

describe('CodexExecClient', () => {
  const originalHubSecret = process.env.AZITO_UI_TOKEN;
  const originalHubMarker = process.env.HUB_ONLY_MARKER;

  beforeEach(() => {
    process.env.AZITO_UI_TOKEN = 'hub-secret-token';
    process.env.AZITO_WEBHOOK_TOKEN = 'hub-webhook-token';
    process.env.HUB_ONLY_MARKER = 'should-not-leak';
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    if (originalHubSecret === undefined) delete process.env.AZITO_UI_TOKEN;
    else process.env.AZITO_UI_TOKEN = originalHubSecret;
    delete process.env.AZITO_WEBHOOK_TOKEN;
    if (originalHubMarker === undefined) delete process.env.HUB_ONLY_MARKER;
    else process.env.HUB_ONLY_MARKER = originalHubMarker;
    vi.restoreAllMocks();
  });

  it('spawns codex with a minimal env allowlist, isolated cwd and sandbox flags', async () => {
    const fakeProc = createFakeProc();
    vi.mocked(spawn).mockImplementation((..._args: unknown[]) => {
      // consume stdin so the prompt file stream can end without blocking
      fakeProc.stdin.resume();
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc as unknown as ReturnType<typeof spawn>;
    });
    vi.mocked(fs.readFileSync).mockReturnValue('llm output');
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});
    const rmSpy = vi.mocked(fs.rmSync).mockImplementation(() => {});
    const mkdtempSpy = vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/codex-exec-fake123');
    vi.mocked(fs.createReadStream).mockReturnValue(new PassThrough() as unknown as fs.ReadStream);

    const client = new CodexExecClient(5000);
    const output = await client.exec('untrusted prompt text');

    expect(output).toBe('llm output');
    expect(mkdtempSpy).toHaveBeenCalled();

    const [command, args, options] = vi.mocked(spawn).mock.calls[0] as [
      string,
      string[],
      { cwd?: string; env?: NodeJS.ProcessEnv },
    ];
    expect(command).toBe('codex');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--ignore-user-config');

    // cwd must be an explicit, isolated directory distinct from the hub's own cwd
    expect(options.cwd).toBeDefined();
    expect(options.cwd).not.toBe(process.cwd());
    expect(options.cwd).toBe('/tmp/codex-exec-fake123');

    const env = options.env ?? {};
    const leakedAzitoKeys = Object.keys(env).filter((k) => k.startsWith('AZITO_'));
    expect(leakedAzitoKeys).toEqual([]);
    expect(env.HUB_ONLY_MARKER).toBeUndefined();

    expect(rmSpy).toHaveBeenCalledWith('/tmp/codex-exec-fake123', { recursive: true, force: true });
  });
});
