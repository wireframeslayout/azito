import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnixSecretFileGuard } from '../../../shared/os/secretFileGuard';
import { UpdateStateManager, type UpdateState } from '../UpdateStateManager';
import type { UpdateBackend } from '../updateBackend';
import { runUpdateSteps } from '../updateScript';

const ZIP = Buffer.from('not really a zip, the fake backend never opens it');
const SHA = createHash('sha256').update(ZIP).digest('hex');

vi.mock('../updateHealth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../updateHealth')>()),
  waitForHealthyVersion: vi.fn(async () => undefined),
}));
import { waitForHealthyVersion } from '../updateHealth';

describe('runUpdateSteps (the part of update-run that is the same on every OS)', () => {
  let dir: string;
  let hubDir: string;
  let stateManager: UpdateStateManager;
  let state: UpdateState;
  let sumsText: string;
  const download = vi.fn();

  const args = () => ({
    dataDir: dir, hubDir, version: 'v1.1.0', oldVersion: 'v1.0.0', serviceManager: 'taskscheduler' as const,
    tarballUrl: 'http://127.0.0.1:1/dl/azito-hub-v1.1.0-win32-x64.zip', sha256sumsUrl: 'http://127.0.0.1:1/dl/SHA256SUMS',
  });

  function backend(overrides: Partial<UpdateBackend> = {}): UpdateBackend {
    return {
      archiveName: 'azito-hub.zip',
      healthTimeoutMs: 1000,
      currentRef: () => 'v1.0.0',
      extract: vi.fn(async (_archive: string, installDir: string) => { fs.mkdirSync(installDir, { recursive: true }); }),
      smokeTest: vi.fn(async () => undefined),
      switchTo: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      isCurrent: vi.fn(() => false),
      removeInstallDir: vi.fn((installDir: string) => fs.rmSync(installDir, { recursive: true, force: true })),
      ...overrides,
    };
  }

  const run = (b: UpdateBackend, token?: string, signal?: AbortSignal): Promise<void> => runUpdateSteps(args(), b, 'http://127.0.0.1:3001/api/health', token, state, stateManager, signal ?? new AbortController().signal);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-update-script-'));
    hubDir = path.join(dir, 'hub');
    fs.mkdirSync(hubDir);
    stateManager = new UpdateStateManager(path.join(dir, 'update-state.json'), path.join(dir, 'update.log'), new UnixSecretFileGuard());
    state = { status: 'running', step: 'download', fromVersion: 'v1.0.0', toVersion: 'v1.1.0', startedAt: new Date().toISOString(), steps: [] };
    sumsText = `${SHA}  azito-hub-v1.1.0-win32-x64.zip\n`;
    download.mockReset();
    vi.mocked(waitForHealthyVersion).mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      download(url, init?.headers?.Authorization);
      return new Response(url.endsWith('SHA256SUMS') ? sumsText : ZIP);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('goes download, verify, extract, smoke-test, switch, restart, health-check in that order and records success', async () => {
    const order: string[] = [];
    const b = backend({
      extract: vi.fn(async (_a: string, installDir: string) => { order.push('extract'); fs.mkdirSync(installDir, { recursive: true }); }),
      smokeTest: vi.fn(async () => { order.push('smoke-test'); }),
      switchTo: vi.fn(async () => { order.push('switch'); }),
      restart: vi.fn(async () => { order.push('restart'); }),
    });
    await run(b, 'tok');
    expect(order).toEqual(['extract', 'smoke-test', 'switch', 'restart']);
    expect(state.status).toBe('success');
    expect(state.steps.map((s) => s.step)).toEqual(['download', 'verify', 'extract', 'smoke-test', 'switch', 'restart', 'health-check']);
    expect(waitForHealthyVersion).toHaveBeenCalledWith('http://127.0.0.1:3001/api/health', 'v1.1.0', 1000);
    expect(b.rollback).not.toHaveBeenCalled();
    expect(stateManager.read()?.status).toBe('success');
    // The token goes to the download, and only there.
    expect(download.mock.calls.map((c) => c[1])).toEqual(['Bearer tok', 'Bearer tok']);
    expect(fs.readFileSync(path.join(dir, 'update.log'), 'utf-8')).not.toContain('tok\n');
  });

  it('stops at verify when the SHA256 does not match: nothing is extracted, and nothing was switched so the rollback is told so', async () => {
    sumsText = `${'0'.repeat(64)}  azito-hub-v1.1.0-win32-x64.zip\n`;
    const b = backend();
    await run(b);
    expect(state).toMatchObject({ status: 'failed', step: 'verify' });
    expect(state.error).toMatch(/SHA256 mismatch/);
    expect(b.extract).not.toHaveBeenCalled();
    expect(b.rollback).toHaveBeenCalledWith('v1.0.0', false);
  });

  it('stops at the smoke test and removes the folder this run made', async () => {
    const b = backend({ smokeTest: vi.fn(async () => { throw new Error('Smoke test version mismatch'); }) });
    await run(b);
    expect(state).toMatchObject({ status: 'failed', step: 'smoke-test' });
    expect(b.switchTo).not.toHaveBeenCalled();
    expect(b.rollback).toHaveBeenCalledWith('v1.0.0', false);
    expect(fs.existsSync(path.join(hubDir, 'v1.1.0'))).toBe(false);
  });

  it('puts the old version back when the health check fails after the switch, and removes the new folder', async () => {
    vi.mocked(waitForHealthyVersion).mockRejectedValueOnce(new Error('Health check timed out: fetch failed'));
    const b = backend();
    await run(b);
    expect(state).toMatchObject({ status: 'failed', step: 'health-check' });
    expect(state.error).toBe('Health check timed out: fetch failed');
    expect(b.rollback).toHaveBeenCalledWith('v1.0.0', true);
    expect(b.removeInstallDir).toHaveBeenCalledWith(path.join(hubDir, 'v1.1.0'));
    expect(fs.existsSync(path.join(hubDir, 'v1.1.0'))).toBe(false);
  });

  it('keeps a folder that was there before, and the one that is in use', async () => {
    fs.mkdirSync(path.join(hubDir, 'v1.1.0'));
    const existing = backend({ restart: vi.fn(async () => { throw new Error('boom'); }) });
    await run(existing);
    expect(existing.removeInstallDir).not.toHaveBeenCalled();

    fs.rmSync(path.join(hubDir, 'v1.1.0'), { recursive: true });
    state = { ...state, status: 'running', steps: [], error: undefined };
    const inUse = backend({ restart: vi.fn(async () => { throw new Error('boom'); }), isCurrent: vi.fn(() => true) });
    await run(inUse);
    expect(inUse.removeInstallDir).not.toHaveBeenCalled();
  });

  it('says so when going back also failed, with both reasons', async () => {
    const b = backend({
      restart: vi.fn(async () => { throw new Error('the task did not stop'); }),
      rollback: vi.fn(async () => { throw new Error('the old version is not healthy'); }),
    });
    await run(b);
    expect(state.status).toBe('failed');
    expect(state.error).toBe('the task did not stop (going back to v1.0.0 also failed: the old version is not healthy)');
  });

  it('a folder that cannot be removed does not hide the failure that caused it', async () => {
    vi.mocked(waitForHealthyVersion).mockRejectedValueOnce(new Error('Health check timed out'));
    const b = backend({ removeInstallDir: vi.fn(() => { throw new Error('EBUSY'); }) });
    await run(b);
    expect(state.error).toBe('Health check timed out');
    expect(stateManager.readLog().join('\n')).toMatch(/Could not remove .*EBUSY/);
  });

  it('puts the old version back when only the state write right after the switch fails', async () => {
    const realWrite = stateManager.write.bind(stateManager);
    let failed = false;
    vi.spyOn(stateManager, 'write').mockImplementation((s) => {
      const last = s.steps[s.steps.length - 1];
      if (!failed && last?.step === 'switch' && last.status === 'ok') { failed = true; throw new Error('EBUSY: state file is locked'); }
      realWrite(s);
    });
    const b = backend();
    await run(b);
    expect(b.switchTo).toHaveBeenCalled();
    expect(b.rollback).toHaveBeenCalledWith('v1.0.0', true);
    expect(state).toMatchObject({ status: 'failed', step: 'switch' });
  });

  it('a run told to end during the restart lets the restart finish, stops at the next step, and only then puts the old version back', async () => {
    const abort = new AbortController();
    const events: string[] = [];
    const b = backend({
      restart: vi.fn(async () => {
        events.push('restart-start');
        abort.abort(new Error('The update did not finish within 50 minutes'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('restart-end');
      }),
      rollback: vi.fn(async () => { events.push('rollback'); }),
    });
    await run(b, undefined, abort.signal);
    expect(events).toEqual(['restart-start', 'restart-end', 'rollback']);
    expect(state).toMatchObject({ status: 'failed', step: 'health-check', error: 'The update did not finish within 50 minutes' });
    expect(b.rollback).toHaveBeenCalledWith('v1.0.0', true);
    expect(waitForHealthyVersion).not.toHaveBeenCalled();
  });

  it('a run told to end while the pointer is being written (with its retries) rolls back only after the write is settled', async () => {
    const abort = new AbortController();
    const events: string[] = [];
    const b = backend({
      switchTo: vi.fn(async () => {
        abort.abort(new Error('The update task was ended'));
        await new Promise((resolve) => setTimeout(resolve, 20)); // the retries of a busy current.txt
        events.push('pointer-written');
      }),
      rollback: vi.fn(async (_ref: string, switched: boolean) => { events.push(`rollback(${switched})`); }),
    });
    await run(b, undefined, abort.signal);
    expect(events).toEqual(['pointer-written', 'rollback(true)']);
    expect(b.restart).not.toHaveBeenCalled();
    expect(state).toMatchObject({ status: 'failed', step: 'restart' });
  });

  it('a download cut short by the abort is a failed step, nothing was switched, and no stream error escapes', async () => {
    const abort = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); setTimeout(() => abort.abort(new Error('The update task was ended')), 10); },
      // never closes: a server that stopped answering in the middle of the body
    }))));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    process.on('uncaughtException', unhandled);
    try {
      const b = backend();
      await run(b, undefined, abort.signal);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(state).toMatchObject({ status: 'failed', step: 'download' });
      expect(state.error).toMatch(/ended|abort/i);
      expect(b.rollback).toHaveBeenCalledWith('v1.0.0', false);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      process.off('uncaughtException', unhandled);
    }
  });
});
