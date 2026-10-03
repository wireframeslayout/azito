import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MisaoConnection } from './MisaoConnection';
import { MisaoChangeEvents, CHANGE_COALESCE_MS } from './misaoChangeEvents';
import { MisaoPaneStateEvents } from './misaoPaneStateEvents';

// Drives a real misao daemon started in a throwaway directory (never the resident ~/.misao one).
const MISAO_CLI = process.env.MISAO_CLI ?? path.join(os.homedir(), 'workspace/misao/packages/cli/dist/main.js');

const BURST = 'i=0; while [ $i -lt 15 ]; do head -c 400 /dev/zero | tr "\\0" x; echo; sleep 0.2; i=$((i+1)); done; sleep 30';

describe.skipIf(!fs.existsSync(MISAO_CLI))('misao event consumers sharing one connection (real daemon)', () => {
  let dir: string;
  let daemon: ChildProcess;
  let daemonPid: number;
  let connection: MisaoConnection;
  const warn = vi.fn();
  const onChange = vi.fn();
  const handleState = vi.fn();
  const handleSnapshot = vi.fn();
  const handleDisconnected = vi.fn();

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azme-'));
    const socketPath = path.join(dir, 'm.sock');
    daemon = spawn(process.execPath, [MISAO_CLI, 'serve', '--socket', socketPath, '--data', dir], { stdio: 'ignore' });
    daemonPid = daemon.pid!;
    await vi.waitFor(() => expect(fs.existsSync(socketPath)).toBe(true), { timeout: 10000, interval: 50 });
    const sdk = await import('@misao/sdk');
    connection = new MisaoConnection({ socketPath, sdk, log: { warn } });
    await connection.start();
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

  it('starts both consumers in the hub start-up order (change hooks first) and feeds both from one subscription', async () => {
    const changeEvents = new MisaoChangeEvents(connection, onChange, { warn });
    const paneStates = new MisaoPaneStateEvents(connection, { handleState, handleSnapshot, handleDisconnected }, { warn });
    await changeEvents.install('local');
    await paneStates.start();
    expect(handleSnapshot).toHaveBeenCalledTimes(1);

    await connection.request('workspace.create', { name: 'azme-ws' });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('local'), { timeout: CHANGE_COALESCE_MS + 5000, interval: 50 });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('stream already registered'));

    await connection.request('pane.open', { cmd: ['sh', '-c', BURST] });
    // pane.state events reach the pane-state consumer through the same subscription (a byte burst flips the pane to working).
    await vi.waitFor(() => expect(handleState).toHaveBeenCalled(), { timeout: 15000, interval: 100 });
    expect(handleState).toHaveBeenCalledWith(expect.objectContaining({ state: 'working' }));

    changeEvents.uninstall('local');
    paneStates.stop();
  });
});
