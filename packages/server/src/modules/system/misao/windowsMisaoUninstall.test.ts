import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mocks = vi.hoisted(() => ({
  assertUnshared: vi.fn(), prepare: vi.fn(), remove: vi.fn(), pointer: vi.fn(), stop: vi.fn(), query: vi.fn(), lock: vi.fn(),
}));
vi.mock('./windowsMisaoAgentGuard', () => ({ assertNoWindowsAgent: mocks.assertUnshared }));
vi.mock('../windowsHubUninstall', () => ({ prepareRecordedMisao: mocks.prepare, removeRecordedTree: mocks.remove, verifyRecordedMisaoPointer: mocks.pointer }));
vi.mock('./misaoPaths', () => ({ misaoWindowsUserOf: () => ({ userName: 'me' }), resolveMisaoPaths: () => ({ root: 'root' }) }));
vi.mock('./MisaoBundle', () => ({ readMisaoBundle: () => ({ version: 'v1.2.3' }) }));
vi.mock('./misaoLocalWindows', () => ({ createLocalMisaoWindows: () => ({
  taskName: 'AzitoMisao', target: {}, tasks: { query: mocks.query }, installer: { removeOwnedTaskForUninstall: mocks.stop }, operationLock: { run: mocks.lock },
}) }));

import { uninstallRecordedMisao } from './windowsMisaoUninstall';

let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-misao-uninstall-'));
  fs.writeFileSync(path.join(root, 'current'), 'v1.2.3');
  mocks.prepare.mockResolvedValue({ root, version: 'v1.2.3' });
  mocks.pointer.mockReturnValue(path.join(root, 'current'));
  mocks.remove.mockResolvedValue(undefined);
  mocks.assertUnshared.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue({ exists: false });
  mocks.lock.mockImplementation(async (operation: () => Promise<void>) => operation());
  mocks.stop.mockImplementation(async (_target: unknown, _bundle: unknown, _version: string, _taskHash: string, check: () => Promise<void>) => check());
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function input() {
  return { prefix: root, record: { misao: { version: 'v1.2.3', taskHash: 'a'.repeat(64) } }, host: { platform: 'win32' }, bundleRoot: root, guard: {}, run: vi.fn(), systemRoot: 'C:\\Windows', pid: 123 } as never;
}

describe('recorded misao uninstall', () => {
  it('does not stop anything when agent use is possible', async () => {
    mocks.assertUnshared.mockRejectedValue(new Error('agent found'));
    await expect(uninstallRecordedMisao(input())).rejects.toThrow(/agent found/);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('removes the verified release only after the owned task is stopped and agent absence is checked again', async () => {
    await uninstallRecordedMisao(input());
    expect(mocks.assertUnshared).toHaveBeenCalledTimes(3);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(root, 'current'))).toBe(false);
  });

  it('retains the release when a task appears again', async () => {
    mocks.query.mockResolvedValue({ exists: true });
    await expect(uninstallRecordedMisao(input())).rejects.toThrow(/task appeared/);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('does not stop anything if the shared operation lock is unavailable', async () => {
    mocks.lock.mockRejectedValue(new Error('busy'));
    await expect(uninstallRecordedMisao(input())).rejects.toThrow(/busy/);
    expect(mocks.stop).not.toHaveBeenCalled();
  });
});
