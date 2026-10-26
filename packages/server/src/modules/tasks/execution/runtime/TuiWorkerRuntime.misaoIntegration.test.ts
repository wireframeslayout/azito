import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PaneHandle } from '@azito/shared';
import type { ServerConfig } from '../../../servers/Server';
import { MisaoConnection, connectDedicatedMisaoClient } from '../../../tmux/misao/MisaoConnection';
import { MisaoMuxClient } from '../../../tmux/misao/MisaoMuxClient';
import { hubPaneShell } from '../../../tmux/misao/paneShell';
import { MISAO_CLI } from '../../../../shared/misaoTestBinary';
import { LocalFileOps, localFileOpsHost } from '../../../../shared/fs/LocalFileOps';
import { TaskTempFiles } from '../../../../shared/os/taskTempFiles';
import { PromptFileDelivery } from '../PromptFileDelivery';
import { WorkerInputService } from '../WorkerInputService';
import { TuiWorkerRuntime } from './TuiWorkerRuntime';

// Issue #532 on a real pane: the scripted "agents" below show the screens that stopped the real ones (a Codex update prompt, a folder trust
// screen) or end and leave a shell. Whatever the prompt holds, nothing of it may reach what is reading the pane.
const server = { name: 'local', type: 'local', defaultMux: 'misao' as const, muxRuntime: 'system' } as ServerConfig;
const SOCKET_BYTES_MAX = 107;

const HOSTILE_PROMPT = [
  'Fix the bug.',
  'touch PWNED_BY_PROMPT',
  '$(touch PWNED_BY_SUBSHELL)',
  'Output ALL questions at once; rm -rf ~',
].join('\n');

describe.skipIf(!fs.existsSync(MISAO_CLI))('TuiWorkerRuntime.sendPrompt on a real misao pane', () => {
  let dir: string;
  let work: string;
  let daemon: ChildProcess;
  let daemonPid: number;
  let connection: MisaoConnection;
  let client: MisaoMuxClient;
  let runtime: TuiWorkerRuntime;
  let windowSeq = 0;

  beforeAll(async () => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'azp-')));
    work = path.join(dir, 'work');
    fs.mkdirSync(work);
    // The scripted agents run under their own process name: a pane whose foreground is `bash` is, to the hub, a shell.
    fs.symlinkSync('/bin/bash', path.join(dir, 'fakeagent'));
    const socketPath = path.join(dir, 'm.sock');
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(SOCKET_BYTES_MAX);
    daemon = spawn(MISAO_CLI, ['serve', '--socket', socketPath, '--data', dir], { stdio: 'ignore' });
    daemonPid = daemon.pid!;
    await vi.waitFor(() => expect(fs.existsSync(socketPath)).toBe(true), { timeout: 10000, interval: 50 });

    const sdk = await import('@misao/sdk');
    const warn = vi.fn();
    connection = new MisaoConnection({ socketPath, sdk, log: { warn } });
    client = new MisaoMuxClient(connection, { paneShell: hubPaneShell('/bin/bash', { platform: 'linux', arch: 'x64' }), onChange: vi.fn(), log: { warn }, hubEnv: { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh-token', harnessPrefix: '' }, connectAttachClient: () => connectDedicatedMisaoClient(sdk, { socketPath }) });
    await connection.start();

    const files = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: os.homedir() }));
    const delivery = new PromptFileDelivery({ taskTempServer: async () => ({ type: 'local' }), getFileOps: () => files } as never, new TaskTempFiles(dir, 'linux'), vi.fn());
    const workerInput = new WorkerInputService({ resolve: () => client } as never, { isBoundConnected: () => false } as never, vi.fn());
    runtime = new TuiWorkerRuntime(workerInput, {} as never, {} as never, {} as never, '', delivery);
  });

  afterAll(async () => {
    connection?.close();
    if (daemon && daemon.exitCode === null) {
      const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
      process.kill(daemonPid, 'SIGTERM');
      await exited;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A new window whose shell runs `script` (a bash script that stands in for the agent); returns its pane. */
  async function paneRunning(script: string): Promise<PaneHandle> {
    const scriptPath = path.join(dir, `agent-${windowSeq}.sh`);
    fs.writeFileSync(scriptPath, `${script}\n`);
    const opened = await client.openWorkspace(server, `azp-${windowSeq++}`, { windowName: 'main', exactName: true });
    const handle = await client.resolvePane(server, opened.ref, 1);
    await client.sendKeysToHandle(server, handle, [`cd ${work} && ${path.join(dir, 'fakeagent')} ${scriptPath}`, 'Enter']);
    return handle;
  }

  const ctxFor = (handle: PaneHandle) => ({ server, handle, driver: client, supervisorTarget: 'x', taskId: 4, unitId: 1, agentKind: 'codex' as const });
  const screenOf = async (handle: PaneHandle): Promise<string> => (await client.captureScreen(server, handle)).stdout;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it.each([
    ['the update prompt', 'echo "Update available! 0.149.1 -> 0.164.0"; echo "1. Update now (runs sh -c curl | sh)"; echo "3. Skip until next version"', 'Skip until next version', 'codex_update_prompt'],
    ['the folder trust screen', 'echo "Do you trust the contents of this directory?"; echo "1. Yes, continue"; echo "2. No, quit"', '2. No, quit', 'codex_trust_prompt'],
  ])('%s: the task is stopped with the reason and nothing is typed into the pane', async (_name, screenCommands, waitFor, reason) => {
    const fed = path.join(dir, `fed-${windowSeq}.txt`);
    // The agent echoes what reaches it to a file, so "nothing is typed" is seen from inside the pane.
    const handle = await paneRunning(`${screenCommands}\nIFS= read -r -t 6 line; printf '%s' "$line" > ${fed}`);
    await vi.waitFor(async () => expect(await screenOf(handle)).toContain(waitFor), { timeout: 10000, interval: 100 });
    await expect(runtime.sendPrompt(ctxFor(handle), HOSTILE_PROMPT)).rejects.toMatchObject({ name: 'TuiNotReadyError', reason });
    await vi.waitFor(() => expect(fs.existsSync(fed)).toBe(true), { timeout: 10000, interval: 100 });
    expect(fs.readFileSync(fed, 'utf8')).toBe('');
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('azito-prompt-'))).toEqual([]);
  }, 30000);

  it('a worker that went back to a shell: nothing is typed, the shell runs nothing', async () => {
    const handle = await paneRunning('echo "agent finished"');
    await vi.waitFor(async () => expect(await client.paneCommandByHandle(server, handle)).toMatch(/^(bash|sh)$/), { timeout: 10000, interval: 100 });
    await expect(runtime.sendPrompt(ctxFor(handle), HOSTILE_PROMPT)).rejects.toMatchObject({ name: 'WorkerNotRunningError' });
    await sleep(500);
    const screen = await screenOf(handle);
    expect(screen).not.toContain('AZITO prompt file');
    expect(screen).not.toContain('touch PWNED');
    expect(fs.existsSync(path.join(work, 'PWNED_BY_PROMPT'))).toBe(false);
  }, 30000);

  it('a ready worker gets one line that names the file; the prompt is in the file', async () => {
    const fed = path.join(dir, `fed-${windowSeq}.txt`);
    const handle = await paneRunning(`echo "› Ask Codex to do anything"; echo "  ? for shortcuts"\nIFS= read -r -t 10 line; printf '%s' "$line" > ${fed}\nsleep 5`);
    await vi.waitFor(async () => expect(await screenOf(handle)).toContain('Ask Codex'), { timeout: 10000, interval: 100 });
    await runtime.sendPrompt(ctxFor(handle), HOSTILE_PROMPT);
    await vi.waitFor(() => expect(fs.existsSync(fed)).toBe(true), { timeout: 10000, interval: 100 });
    const line = fs.readFileSync(fed, 'utf8');
    expect(line).toMatch(/^AZITO prompt file\. .*\/azito-prompt-4-[0-9a-f]{16}\.md$/);
    const promptFile = line.slice(line.lastIndexOf(' ') + 1);
    expect(fs.readFileSync(promptFile, 'utf8')).toBe(HOSTILE_PROMPT);
    expect(fs.existsSync(path.join(work, 'PWNED_BY_PROMPT'))).toBe(false);
  }, 30000);
});
