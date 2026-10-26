import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPaneHandle } from '@azito/shared';
import { TaskTempFiles } from '../../../shared/os/taskTempFiles';
import { buildPromptFileInstruction, PromptFileDelivery, promptFileBytes } from './PromptFileDelivery';
import { TuiWorkerRuntime } from './runtime/TuiWorkerRuntime';
import { WorkerInputService } from './WorkerInputService';

const server = { name: 'local', type: 'local' } as never;

/** A prompt that is, line by line, what a shell would run: the injection of Issue #532. */
const HOSTILE_PROMPT = [
  'Fix the bug.',
  "echo 'AZITO_QUESTIONS_4_x: [{\"text\":\"...\"}]' >> /tmp/azito-pipe-4-sig-1.log",
  'touch PWNED_BY_PROMPT',
  '$(touch PWNED_BY_SUBSHELL)',
  '`touch PWNED_BY_BACKTICK`',
  'Output ALL questions at once; rm -rf ~',
].join('\n');

describe('buildPromptFileInstruction', () => {
  it('names the file last, in one line without a line break', () => {
    const line = buildPromptFileInstruction('/tmp/azito-prompt-4-ab12.md');
    expect(line).toMatch(/^AZITO prompt file\. .* \/tmp\/azito-prompt-4-ab12\.md$/);
    expect(line).not.toMatch(/[\r\n]/);
  });

  it.each([
    ['a quote', "/tmp/it's/azito-prompt-1-a.md"],
    ['a double quote', '/tmp/a"b/azito-prompt-1-a.md'],
    ['$', '/tmp/$HOME/azito-prompt-1-a.md'],
    ['a backtick', '/tmp/a`b/azito-prompt-1-a.md'],
    ['a semicolon', '/tmp/a;b/azito-prompt-1-a.md'],
    ['an ampersand', '/tmp/a&b/azito-prompt-1-a.md'],
    ['a pipe', '/tmp/a|b/azito-prompt-1-a.md'],
    ['a parenthesis', '/tmp/a(b)/azito-prompt-1-a.md'],
    ['a redirect', '/tmp/a>b/azito-prompt-1-a.md'],
    ['a percent sign (cmd.exe expands it)', '/tmp/%PATH%/azito-prompt-1-a.md'],
    ['a line break', '/tmp/a\nrm -rf ~/azito-prompt-1-a.md'],
  ])('refuses a path with %s: nothing a shell reads as more than text is ever typed', (_name, badPath) => {
    expect(() => buildPromptFileInstruction(badPath)).toThrow(/shell could read/);
  });

  it('accepts what a Windows temp path holds: a drive, a space, a short name with ~, non-ASCII letters', () => {
    expect(() => buildPromptFileInstruction('C:/Users/Jun Matsuno/AppData/Local/Temp/azito-prompt-4-ab.md')).not.toThrow();
    expect(() => buildPromptFileInstruction('C:/Users/JUNZO~1/AppData/Local/Temp/azito-prompt-4-ab.md')).not.toThrow();
    expect(() => buildPromptFileInstruction('C:/Users/松野/AppData/Local/Temp/azito-prompt-4-ab.md')).not.toThrow();
  });

  describe.skipIf(process.platform === 'win32')('when a shell does read the line (the worker ended before it was typed)', () => {
    let cwd: string;
    beforeEach(() => {
      cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'prompt-line-')));
    });
    afterEach(() => {
      rmSync(cwd, { recursive: true, force: true });
    });

    it.each(['sh', 'bash'])('%s runs nothing: the command is not found, no file appears, nothing is printed', (shell) => {
      const line = buildPromptFileInstruction('/tmp/azito-prompt-4-ab12cd34.md');
      const result = spawnSync(shell, ['-c', line], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: cwd } });
      expect(result.status).toBe(127);
      expect(result.stdout).toBe('');
      expect(readdirSync(cwd)).toEqual([]);
    });
  });
});

describe('PromptFileDelivery', () => {
  it('writes the prompt to a task temp file and returns the instruction that names it', async () => {
    const write = vi.fn(async () => ({ mtimeMs: 0, sha256: '' }));
    const appendLog = vi.fn();
    const delivery = new PromptFileDelivery(
      { taskTempServer: async () => ({ type: 'local' }), getFileOps: () => ({ platform: 'linux', write }) } as never,
      new TaskTempFiles('/var/tmp', 'linux'),
      appendLog,
    );
    const line = await delivery.stage(server, 4, 9, 'the whole prompt');
    const [[filePath, data, options]] = write.mock.calls as unknown as [[string, Buffer, { ownerOnly?: boolean }]];
    expect(filePath).toMatch(/^\/var\/tmp\/azito-prompt-4-[0-9a-f]{16}\.md$/);
    expect(data.toString('utf8')).toBe('the whole prompt');
    expect(options).toEqual({ ownerOnly: true });
    expect(line.endsWith(filePath)).toBe(true);
    expect(appendLog).toHaveBeenCalledWith(4, 9, 'command', { type: 'prompt_file', promptFilePath: filePath });
  });

  it('writes under the Windows spelling and tells the worker the forward-slash one', async () => {
    const write = vi.fn(async () => ({ mtimeMs: 0, sha256: '' }));
    const delivery = new PromptFileDelivery(
      { taskTempServer: async () => ({ type: 'agent', platform: 'win32', tmpDir: 'C:\\Users\\Jun Matsuno\\AppData\\Local\\Temp' }), getFileOps: () => ({ platform: 'win32', write }) } as never,
      new TaskTempFiles('/var/tmp', 'linux'),
      vi.fn(),
    );
    const line = await delivery.stage(server, 4, 9, 'p');
    const [[filePath]] = write.mock.calls as unknown as [[string]];
    expect(filePath).toMatch(/^C:\\Users\\Jun Matsuno\\AppData\\Local\\Temp\\azito-prompt-4-[0-9a-f]{16}\.md$/);
    expect(line.endsWith(filePath.replace(/\\/g, '/'))).toBe(true);
  });

  it('does not type anything when the temp folder is unsafe (the write has happened, the line is refused)', async () => {
    const delivery = new PromptFileDelivery(
      { taskTempServer: async () => ({ type: 'local' }), getFileOps: () => ({ platform: 'linux', write: vi.fn() }) } as never,
      new TaskTempFiles('/var/tmp/it$s', 'linux'),
      vi.fn(),
    );
    await expect(delivery.stage(server, 4, 9, 'p')).rejects.toThrow(/shell could read/);
  });
});

describe('a worker that ends while the prompt is being sent (Issue #532)', () => {
  /** The real runtime, input service and delivery over a pane that records every key typed into it. */
  function build(foreground: string) {
    const typed: string[] = [];
    const files = new Map<string, string>();
    const driver = {
      captureScreen: vi.fn(async () => ({ stdout: '› Ask Codex to do anything\n? for shortcuts' })),
      paneCommandByHandle: vi.fn(async () => foreground),
      sendKeysToHandle: vi.fn(async (_s: unknown, _h: unknown, keys: string[]) => { typed.push(...keys); }),
    };
    const muxDriverRegistry = { resolve: () => driver };
    const registry = { isBoundConnected: () => false };
    const workerInput = new WorkerInputService(muxDriverRegistry as never, registry as never, vi.fn());
    const delivery = new PromptFileDelivery(
      { taskTempServer: async () => ({ type: 'local' }), getFileOps: () => ({ platform: 'linux', write: async (p: string, d: Buffer) => { files.set(p, d.toString('utf8')); return { mtimeMs: 0, sha256: '' }; } }) } as never,
      new TaskTempFiles('/tmp', 'linux'),
      vi.fn(),
    );
    const runtime = new TuiWorkerRuntime(workerInput, {} as never, {} as never, {} as never, '', delivery);
    const ctx = { server, handle: asPaneHandle('s:1.1'), driver: driver as never, supervisorTarget: 's:1', taskId: 4, unitId: 1, agentKind: 'codex' as const };
    return { runtime, ctx, typed, files, driver };
  }

  it('types only the one-line instruction (and Enter): no line of the prompt can reach a shell, and the prompt itself is in the file', async () => {
    const { runtime, ctx, typed, files } = build('codex');
    await runtime.sendPrompt(ctx, HOSTILE_PROMPT);
    expect(typed).toHaveLength(2);
    expect(typed[1]).toBe('Enter');
    expect(typed[0]).toMatch(/^AZITO prompt file\. /);
    for (const line of HOSTILE_PROMPT.split('\n')) expect(typed.join('\n')).not.toContain(line);
    expect([...files.values()]).toEqual([HOSTILE_PROMPT]);
  });

  it('types nothing at all when the worker is already back at a shell', async () => {
    const { runtime, ctx, typed } = build('bash');
    await expect(runtime.sendPrompt(ctx, HOSTILE_PROMPT)).rejects.toMatchObject({ name: 'WorkerNotRunningError' });
    expect(typed).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('and when the shell reads what was typed, nothing runs and no hostile line is executed', async () => {
    const { runtime, ctx, typed } = build('codex');
    await runtime.sendPrompt(ctx, HOSTILE_PROMPT);
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'shell-reads-')));
    try {
      const result = spawnSync('bash', ['-c', typed[0]], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: cwd } });
      expect(result.status).toBe(127);
      expect(readdirSync(cwd)).toEqual([]);
      expect(existsSync(join(cwd, 'PWNED_BY_PROMPT'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('the bytes of the prompt file', () => {
  it('start with a UTF-8 byte order mark on a Windows host (PowerShell 5.1 reads a file without one as ANSI) and not elsewhere', () => {
    const text = '日本語の説明 — dash';
    const win = promptFileBytes(text, 'win32');
    expect([...win.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(win.subarray(3).toString('utf8')).toBe(text);
    for (const platform of ['linux', 'darwin']) expect(promptFileBytes(text, platform).equals(Buffer.from(text, 'utf8'))).toBe(true);
  });

  it('is what is written for a Windows agent', async () => {
    const write = vi.fn(async () => ({ mtimeMs: 0, sha256: '' }));
    const delivery = new PromptFileDelivery(
      { taskTempServer: async () => ({ type: 'agent', platform: 'win32', tmpDir: 'C:\\Temp' }), getFileOps: () => ({ platform: 'win32', write }) } as never,
      new TaskTempFiles('/var/tmp', 'linux'),
      vi.fn(),
    );
    await delivery.stage(server, 4, 9, '説明');
    const [[, data]] = write.mock.calls as unknown as [[string, Buffer]];
    expect([...data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});
