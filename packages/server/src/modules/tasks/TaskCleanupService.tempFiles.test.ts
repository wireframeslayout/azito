import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskCleanupService } from './TaskCleanupService';
import type { Task } from './Task';
import { TaskTempFiles } from '../../shared/os/taskTempFiles';
import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';

describe('TaskCleanupService temp files', () => {
  let dir: string;
  let otherDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-hub-'));
    otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-other-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  function service(serverType: 'local' | 'agent', logs: unknown[], hostFiles: Partial<IFileOps> = { platform: 'linux', remove: async () => undefined }): TaskCleanupService {
    return new TaskCleanupService({
      serverRepo: { findByName: () => ({ name: 's', type: serverType }) } as never,
      worktreeServiceFactory: {} as never,
      transportFactory: { getTransport: () => ({ files: () => hostFiles }) } as never,
      projectServerRepo: { find: () => null, findByProject: () => [] } as never,
      projectRepo: {} as never,
      muxDriverRegistry: {} as never,
      windowRepo: {} as never,
      logRepo: { findByTask: () => logs } as never,
      taskTempFiles: new TaskTempFiles(dir, process.platform === 'win32' ? 'win32' : 'linux'),
    });
  }
  const task = { id: 5, projectId: 1, serverName: 's', worktreePath: null } as unknown as Task;

  it('removes the task\'s files from the hub temp folder and leaves other tasks\' files', async () => {
    for (const name of ['azito-pipe-5-1.log', 'azito-pipe-5-sig-1.log', 'azito-output-5-a.md', 'azito-rules-5-a.md', 'azito-pipe-50-1.log', 'unrelated.txt']) {
      fs.writeFileSync(path.join(dir, name), 'x');
    }
    const log = { warn: vi.fn() };
    await service('local', []).cleanup(task, log);
    expect(fs.readdirSync(dir).sort()).toEqual(['azito-pipe-50-1.log', 'unrelated.txt']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('removes the paths the task recorded, wherever they are', async () => {
    const recorded = path.join(otherDir, 'azito-output-5-z.md');
    const notTheTasks = path.join(otherDir, 'azito-output-6-z.md');
    fs.writeFileSync(recorded, 'x');
    fs.writeFileSync(notTheTasks, 'x');
    const logs = [{ type: 'command', content: JSON.stringify({ type: 'phase_prompt', outputFilePath: recorded, rulesFilePath: notTheTasks }) }];
    await service('local', logs).cleanup(task, { warn: vi.fn() });
    expect(fs.existsSync(recorded)).toBe(false);
    expect(fs.existsSync(notTheTasks)).toBe(true);
  });

  it('leaves the hub temp folder alone for an agent server', async () => {
    fs.writeFileSync(path.join(dir, 'azito-pipe-5-1.log'), 'x');
    await service('agent', []).cleanup(task, { warn: vi.fn() });
    expect(fs.existsSync(path.join(dir, 'azito-pipe-5-1.log'))).toBe(true);
  });

  // #532: the prompt file holds the task's text and is written on the agent's host, where the hub's own cleanup cannot reach it.
  describe('an agent server\'s host', () => {
    it('removes the recorded prompt file (and the task\'s other recorded files) through the host\'s file operations', async () => {
      const remove = vi.fn(async (_path: string) => undefined);
      const logs = [
        { type: 'command', content: JSON.stringify({ type: 'prompt_file', promptFilePath: '/tmp/azito-prompt-5-0123456789abcdef.md' }) },
        { type: 'command', content: JSON.stringify({ type: 'phase_prompt', outputFilePath: '/tmp/azito-output-5-a.md' }) },
        { type: 'command', content: JSON.stringify({ type: 'prompt_file', promptFilePath: '/tmp/azito-prompt-6-0123456789abcdef.md' }) },
      ];
      await service('agent', logs, { platform: 'linux', remove }).cleanup(task, { warn: vi.fn() });
      expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual(['/tmp/azito-output-5-a.md', '/tmp/azito-prompt-5-0123456789abcdef.md']);
    });

    it('reads a Windows agent\'s paths in the agent\'s notation, whatever OS the hub runs on', async () => {
      const remove = vi.fn(async (_path: string) => undefined);
      const winPath = 'C:\\Users\\Jun Matsuno\\AppData\\Local\\Temp\\azito-prompt-5-0123456789abcdef.md';
      const logs = [{ type: 'command', content: JSON.stringify({ type: 'prompt_file', promptFilePath: winPath }) }];
      await service('agent', logs, { platform: 'win32', remove }).cleanup(task, { warn: vi.fn() });
      expect(remove).toHaveBeenCalledWith(winPath);
    });

    it('does not remove a path that is not this task\'s prompt file, and does not warn about a file that is already gone', async () => {
      const remove = vi.fn(async (_path: string) => { throw new FileOpsError('NOT_FOUND', 'gone'); });
      const logs = [
        { type: 'command', content: JSON.stringify({ type: 'prompt_file', promptFilePath: '/etc/passwd' }) },
        { type: 'command', content: JSON.stringify({ type: 'prompt_file', promptFilePath: 'azito-prompt-5-relative.md' }) },
        { type: 'command', content: JSON.stringify({ type: 'prompt_file', promptFilePath: '/tmp/azito-prompt-5-0123456789abcdef.md' }) },
      ];
      const log = { warn: vi.fn() };
      await service('agent', logs, { platform: 'linux', remove }).cleanup(task, log);
      expect(remove.mock.calls).toEqual([['/tmp/azito-prompt-5-0123456789abcdef.md']]);
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('warns, and goes on, when a file cannot be removed', async () => {
      const remove = vi.fn(async (_path: string) => { throw new FileOpsError('PERMISSION_DENIED', 'no'); });
      const logs = [{ type: 'command', content: JSON.stringify({ type: 'prompt_file', promptFilePath: '/tmp/azito-prompt-5-0123456789abcdef.md' }) }];
      const log = { warn: vi.fn() };
      await service('agent', logs, { platform: 'linux', remove }).cleanup(task, log);
      expect(log.warn).toHaveBeenCalledTimes(1);
    });
  });
});
