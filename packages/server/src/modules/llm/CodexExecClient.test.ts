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
    rmSync: vi.fn(),
    mkdtempSync: vi.fn(),
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
  const originalWebhookToken = process.env.AZITO_WEBHOOK_TOKEN;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalCodexAccessToken = process.env.CODEX_ACCESS_TOKEN;

  beforeEach(() => {
    process.env.AZITO_UI_TOKEN = 'hub-secret-token';
    process.env.AZITO_WEBHOOK_TOKEN = 'hub-webhook-token';
    process.env.HUB_ONLY_MARKER = 'should-not-leak';
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    if (originalHubSecret === undefined) delete process.env.AZITO_UI_TOKEN;
    else process.env.AZITO_UI_TOKEN = originalHubSecret;
    if (originalWebhookToken === undefined) delete process.env.AZITO_WEBHOOK_TOKEN;
    else process.env.AZITO_WEBHOOK_TOKEN = originalWebhookToken;
    if (originalHubMarker === undefined) delete process.env.HUB_ONLY_MARKER;
    else process.env.HUB_ONLY_MARKER = originalHubMarker;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    if (originalCodexAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
    else process.env.CODEX_ACCESS_TOKEN = originalCodexAccessToken;
    vi.restoreAllMocks();
  });

  it('spawns codex with a minimal env allowlist, isolated cwd and sandbox flags', async () => {
    const fakeProc = createFakeProc();
    vi.mocked(spawn).mockImplementation((..._args: unknown[]) => {
      // consume stdin so the prompt write can end without blocking
      fakeProc.stdin.resume();
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc as unknown as ReturnType<typeof spawn>;
    });
    vi.mocked(fs.readFileSync).mockReturnValue('llm output');
    const rmSpy = vi.mocked(fs.rmSync).mockImplementation(() => {});
    const mkdtempSpy = vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/codex-exec-fake123');

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
    expect(args).toContain('--skip-git-repo-check');

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

  it('passes CODEX_HOME through to the child process env (required for auth)', async () => {
    process.env.CODEX_HOME = '/home/user/.codex-alt';

    const fakeProc = createFakeProc();
    vi.mocked(spawn).mockImplementation((..._args: unknown[]) => {
      fakeProc.stdin.resume();
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc as unknown as ReturnType<typeof spawn>;
    });
    vi.mocked(fs.readFileSync).mockReturnValue('llm output');
    vi.mocked(fs.rmSync).mockImplementation(() => {});
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/codex-exec-fake456');

    const client = new CodexExecClient(5000);
    await client.exec('untrusted prompt text');

    const [, , options] = vi.mocked(spawn).mock.calls[0] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
    ];
    expect(options.env?.CODEX_HOME).toBe('/home/user/.codex-alt');
  });

  it('passes OPENAI_API_KEY and CODEX_ACCESS_TOKEN through to the child process env (required for auth)', async () => {
    process.env.OPENAI_API_KEY = 'sk-fake-openai-key';
    process.env.CODEX_ACCESS_TOKEN = 'fake-codex-access-token';

    const fakeProc = createFakeProc();
    vi.mocked(spawn).mockImplementation((..._args: unknown[]) => {
      fakeProc.stdin.resume();
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc as unknown as ReturnType<typeof spawn>;
    });
    vi.mocked(fs.readFileSync).mockReturnValue('llm output');
    vi.mocked(fs.rmSync).mockImplementation(() => {});
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/codex-exec-fake999');

    const client = new CodexExecClient(5000);
    await client.exec('untrusted prompt text');

    const [, , options] = vi.mocked(spawn).mock.calls[0] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
    ];
    expect(options.env?.OPENAI_API_KEY).toBe('sk-fake-openai-key');
    expect(options.env?.CODEX_ACCESS_TOKEN).toBe('fake-codex-access-token');
  });

  it('writes the prompt directly to child stdin (no temp prompt file)', async () => {
    const fakeProc = createFakeProc();
    const stdinEndSpy = vi.spyOn(fakeProc.stdin, 'end');
    vi.mocked(spawn).mockImplementation((..._args: unknown[]) => {
      fakeProc.stdin.resume();
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc as unknown as ReturnType<typeof spawn>;
    });
    vi.mocked(fs.readFileSync).mockReturnValue('llm output');
    vi.mocked(fs.rmSync).mockImplementation(() => {});
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/codex-exec-fake789');

    const client = new CodexExecClient(5000);
    await client.exec('untrusted prompt text');

    expect(stdinEndSpy).toHaveBeenCalledWith('untrusted prompt text');
  });

  it('logs a warning when codex exec exits non-zero with empty output', async () => {
    const fakeProc = createFakeProc();
    vi.mocked(spawn).mockImplementation((..._args: unknown[]) => {
      fakeProc.stdin.resume();
      queueMicrotask(() => {
        fakeProc.stderr.emit('data', Buffer.from('auth error: not logged in'));
        fakeProc.emit('close', 1);
      });
      return fakeProc as unknown as ReturnType<typeof spawn>;
    });
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.mocked(fs.rmSync).mockImplementation(() => {});
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/codex-exec-fail1');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new CodexExecClient(5000);
    await expect(client.exec('untrusted prompt text')).rejects.toThrow();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('codex exec failed');
    expect(message).toContain('code=1');
    expect(message).toContain('auth error: not logged in');
    expect(message).not.toContain('untrusted prompt text');
  });

  it('logs a warning when codex spawn emits an error event, followed by close (real Node behavior)', async () => {
    const fakeProc = createFakeProc();
    const rmSpy = vi.mocked(fs.rmSync).mockImplementation(() => {});
    rmSpy.mockClear();
    vi.mocked(spawn).mockImplementation((..._args: unknown[]) => {
      fakeProc.stdin.resume();
      queueMicrotask(() => {
        // Real Node behavior for an actual spawn failure (e.g. ENOENT): 'error' fires,
        // and 'close' still fires afterwards.
        fakeProc.emit('error', new Error('spawn codex ENOENT'));
        fakeProc.emit('close', null);
      });
      return fakeProc as unknown as ReturnType<typeof spawn>;
    });
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/codex-exec-fail2');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new CodexExecClient(5000);
    await expect(client.exec('untrusted prompt text')).rejects.toThrow('spawn codex ENOENT');

    // Only the 'error' handler should settle the promise/log/cleanup; the subsequent
    // 'close' event must be a no-op.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('codex exec failed');
    expect(message).toContain('spawn codex ENOENT');
    expect(rmSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Bearer token', 'Authorization: Bearer abc123.def456', 'Bearer abc123.def456'],
    ['sk- prefixed key', 'invalid key sk-proj-ABCDEF1234567890', 'sk-proj-ABCDEF1234567890'],
    ['ghp_ prefixed token', 'auth failed for ghp_1234567890abcdefghijklmnop', 'ghp_1234567890abcdefghijklmnop'],
    ['gho_ prefixed token', 'auth failed for gho_1234567890abcdefghijklmnop', 'gho_1234567890abcdefghijklmnop'],
    ['ghs_ prefixed token', 'auth failed for ghs_1234567890abcdefghijklmnop', 'ghs_1234567890abcdefghijklmnop'],
    ['glpat- prefixed token', 'auth failed for glpat-AbCdEf12345_-xyz', 'glpat-AbCdEf12345_-xyz'],
    ['token= query value', 'request failed: url?token=supersecretvalue', 'supersecretvalue'],
    ['key= query value', 'request failed: url?key=supersecretvalue', 'supersecretvalue'],
    ['secret= query value', 'request failed: url?secret=supersecretvalue', 'supersecretvalue'],
    ['password= query value', 'request failed: url?password=supersecretvalue', 'supersecretvalue'],
    ['URL userinfo', 'fetch failed: https://user:hunter2@example.com/api', 'user:hunter2@'],
  ])('redacts %s from stderr before logging', async (_label, rawStderr, secret) => {
    const fakeProc = createFakeProc();
    vi.mocked(spawn).mockImplementation((..._args: unknown[]) => {
      fakeProc.stdin.resume();
      queueMicrotask(() => {
        fakeProc.stderr.emit('data', Buffer.from(rawStderr));
        fakeProc.emit('close', 1);
      });
      return fakeProc as unknown as ReturnType<typeof spawn>;
    });
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.mocked(fs.rmSync).mockImplementation(() => {});
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/codex-exec-redact');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new CodexExecClient(5000);
    await expect(client.exec('untrusted prompt text')).rejects.toThrow();

    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).not.toContain(secret);
  });

  it('collapses newlines and control characters in stderr into a single log line', async () => {
    const fakeProc = createFakeProc();
    const rawStderr = 'line one\nfake close event\x1b[1G\tinjected: warn\r\nline three';
    vi.mocked(spawn).mockImplementation((..._args: unknown[]) => {
      fakeProc.stdin.resume();
      queueMicrotask(() => {
        fakeProc.stderr.emit('data', Buffer.from(rawStderr));
        fakeProc.emit('close', 1);
      });
      return fakeProc as unknown as ReturnType<typeof spawn>;
    });
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.mocked(fs.rmSync).mockImplementation(() => {});
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/codex-exec-oneline');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new CodexExecClient(5000);
    await expect(client.exec('untrusted prompt text')).rejects.toThrow();

    const message = warnSpy.mock.calls[0][0] as string;
    expect(message.split('\n')).toHaveLength(1);
    expect(message).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('does not log a warning on success', async () => {
    const fakeProc = createFakeProc();
    vi.mocked(spawn).mockImplementation((..._args: unknown[]) => {
      fakeProc.stdin.resume();
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc as unknown as ReturnType<typeof spawn>;
    });
    vi.mocked(fs.readFileSync).mockReturnValue('llm output');
    vi.mocked(fs.rmSync).mockImplementation(() => {});
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/codex-exec-ok1');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new CodexExecClient(5000);
    await client.exec('untrusted prompt text');

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
