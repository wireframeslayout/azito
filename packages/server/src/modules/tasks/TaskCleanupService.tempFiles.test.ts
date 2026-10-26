import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskCleanupService } from './TaskCleanupService';
import type { Task } from './Task';
import { TaskTempFiles } from '../../shared/os/taskTempFiles';
import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';
import { LocalFileOps, localFileOpsHost } from '../../shared/fs/LocalFileOps';

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

  function service(
    serverType: 'local' | 'agent',
    logs: unknown[],
    hostFiles: Partial<IFileOps> = { platform: 'linux', unlink: async () => undefined },
    agentTmpDir = '/tmp',
  ): TaskCleanupService {
    return new TaskCleanupService({
      serverRepo: { findByName: () => ({ name: 's', type: serverType }) } as never,
      worktreeServiceFactory: {} as never,
      transportFactory: { getTransport: () => ({ files: () => hostFiles }), taskTempServer: async () => ({ type: 'agent', platform: hostFiles.platform, tmpDir: agentTmpDir }) } as never,
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
    const recordedPromptFile = (promptFilePath: string) => ({ type: 'command', content: JSON.stringify({ type: 'prompt_file', promptFilePath }) });
    /** A host whose files are this machine's, behind the real file operations; the agent's temp folder is `tmp`. */
    function realHost(): { files: LocalFileOps; tmp: string } {
      const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-agent-')));
      return { files: new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: tmp })), tmp };
    }

    it('removes the recorded prompt file and the task\'s other recorded files from the agent\'s temp folder, and only those', async () => {
      const { files, tmp } = realHost();
      try {
        for (const name of ['azito-prompt-5-0123456789abcdef.md', 'azito-output-5-a.md', 'azito-prompt-6-0123456789abcdef.md', 'keep.txt']) fs.writeFileSync(path.join(tmp, name), 'x');
        const logs = [
          recordedPromptFile(path.join(tmp, 'azito-prompt-5-0123456789abcdef.md')),
          { type: 'command', content: JSON.stringify({ type: 'phase_prompt', outputFilePath: path.join(tmp, 'azito-output-5-a.md') }) },
          recordedPromptFile(path.join(tmp, 'azito-prompt-6-0123456789abcdef.md')),
        ];
        const warn = vi.fn();
        await service('agent', logs, files, tmp).cleanup(task, { warn });
        expect(fs.readdirSync(tmp).sort()).toEqual(['azito-prompt-6-0123456789abcdef.md', 'keep.txt']);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('does not touch a file outside the agent\'s temp folder, even with the task\'s file name', async () => {
      const { files, tmp } = realHost();
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-project-'));
      try {
        const outside = path.join(elsewhere, 'azito-prompt-5-important');
        fs.writeFileSync(outside, 'precious');
        const warn = vi.fn();
        await service('agent', [recordedPromptFile(outside)], files, tmp).cleanup(task, { warn });
        expect(fs.readFileSync(outside, 'utf8')).toBe('precious');
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('does not remove a directory with the task\'s file name (nothing recursive), and says so', async () => {
      const { files, tmp } = realHost();
      try {
        const dir = path.join(tmp, 'azito-prompt-5-important');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'inside.txt'), 'precious');
        const warn = vi.fn();
        await service('agent', [recordedPromptFile(dir)], files, tmp).cleanup(task, { warn });
        expect(fs.readFileSync(path.join(dir, 'inside.txt'), 'utf8')).toBe('precious');
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform === 'win32')('does not follow a link in the parent out of the temp folder', async () => {
      const { files, tmp } = realHost();
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-linked-'));
      try {
        fs.writeFileSync(path.join(elsewhere, 'azito-prompt-5-0123456789abcdef.md'), 'precious');
        fs.symlinkSync(elsewhere, path.join(tmp, 'link'));
        const warn = vi.fn();
        await service('agent', [recordedPromptFile(path.join(tmp, 'link', 'azito-prompt-5-0123456789abcdef.md'))], files, tmp).cleanup(task, { warn });
        expect(fs.readFileSync(path.join(elsewhere, 'azito-prompt-5-0123456789abcdef.md'), 'utf8')).toBe('precious');
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform === 'win32')('removes a link with the task\'s file name as the link, not what it points at', async () => {
      const { files, tmp } = realHost();
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-target-'));
      try {
        fs.writeFileSync(path.join(elsewhere, 'target.txt'), 'precious');
        fs.symlinkSync(path.join(elsewhere, 'target.txt'), path.join(tmp, 'azito-prompt-5-0123456789abcdef.md'));
        await service('agent', [recordedPromptFile(path.join(tmp, 'azito-prompt-5-0123456789abcdef.md'))], files, tmp).cleanup(task, { warn: vi.fn() });
        expect(fs.existsSync(path.join(tmp, 'azito-prompt-5-0123456789abcdef.md'))).toBe(false);
        expect(fs.readFileSync(path.join(elsewhere, 'target.txt'), 'utf8')).toBe('precious');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('reads a Windows agent\'s paths in the agent\'s notation, whatever OS the hub runs on', async () => {
      const tmpDir = 'C:\\Users\\Jun Matsuno\\AppData\\Local\\Temp';
      const winPath = `${tmpDir}\\azito-prompt-5-0123456789abcdef.md`;
      const unlink = vi.fn(async (_path: string) => undefined);
      const realpath = vi.fn(async (p: string) => p);
      await service('agent', [recordedPromptFile(winPath)], { platform: 'win32', unlink, realpath }, tmpDir).cleanup(task, { warn: vi.fn() });
      expect(unlink).toHaveBeenCalledWith(winPath);
    });

    it('still completes the cleanup, with one warning, when the agent is offline (its temp folder cannot be asked for)', async () => {
      const logs = [recordedPromptFile('/tmp/azito-prompt-5-0123456789abcdef.md')];
      const warn = vi.fn();
      const offline = service('agent', logs, { platform: 'linux', unlink: vi.fn() });
      (offline as unknown as { deps: { transportFactory: { taskTempServer: () => Promise<never> } } }).deps.transportFactory.taskTempServer = async () => { throw new Error('agent unreachable'); };
      await expect(offline.cleanup(task, { warn })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/agent unreachable/);
    });

    it('still completes the cleanup, with one warning, when the real path of the temp folder cannot be read', async () => {
      const logs = [recordedPromptFile('/tmp/azito-prompt-5-0123456789abcdef.md')];
      const warn = vi.fn();
      const unlink = vi.fn();
      const realpath = vi.fn(async () => { throw new FileOpsError('FAILED', 'agent timed out'); });
      await expect(service('agent', logs, { platform: 'linux', unlink, realpath }).cleanup(task, { warn })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(unlink).not.toHaveBeenCalled();
    });

    it('does not warn about a file that is already gone, and warns (and goes on) when one cannot be removed', async () => {
      const realpath = async (p: string) => p;
      const gone = vi.fn(async (_path: string) => { throw new FileOpsError('NOT_FOUND', 'gone'); });
      const goneWarn = vi.fn();
      await service('agent', [recordedPromptFile('/tmp/azito-prompt-5-0123456789abcdef.md')], { platform: 'linux', unlink: gone, realpath }).cleanup(task, { warn: goneWarn });
      expect(gone).toHaveBeenCalledTimes(1);
      expect(goneWarn).not.toHaveBeenCalled();

      const denied = vi.fn(async (_path: string) => { throw new FileOpsError('PERMISSION_DENIED', 'no'); });
      const deniedWarn = vi.fn();
      await service('agent', [recordedPromptFile('/tmp/azito-prompt-5-0123456789abcdef.md')], { platform: 'linux', unlink: denied, realpath }).cleanup(task, { warn: deniedWarn });
      expect(deniedWarn).toHaveBeenCalledTimes(1);
    });
  });
});
