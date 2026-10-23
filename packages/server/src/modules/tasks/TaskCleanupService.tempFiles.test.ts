import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskCleanupService } from './TaskCleanupService';
import type { Task } from './Task';
import { TaskTempFiles } from '../../shared/os/taskTempFiles';

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

  function service(serverType: 'local' | 'agent', logs: unknown[]): TaskCleanupService {
    return new TaskCleanupService({
      serverRepo: { findByName: () => ({ name: 's', type: serverType }) } as never,
      worktreeServiceFactory: {} as never,
      transportFactory: {} as never,
      projectServerRepo: { find: () => null, findByProject: () => [] } as never,
      projectRepo: {} as never,
      muxDriverRegistry: {} as never,
      windowRepo: {} as never,
      logRepo: { findByTask: () => logs } as never,
      taskTempFiles: new TaskTempFiles(dir, 'linux'),
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
});
