import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { asPaneHandle, type PaneHandle } from '@azito/shared';
import { MisaoConnection } from './MisaoConnection';
import { MisaoPaneStream } from './MisaoPaneStream';

// Drives a real misao daemon started in a throwaway directory (never the resident ~/.misao one).
const MISAO_CLI = process.env.MISAO_CLI ?? path.join(os.homedir(), 'workspace/misao/packages/cli/dist/main.js');
const SOCKET_BYTES_MAX = 107;

/** A unix-socket relay between the hub and the daemon that can be cut and restored, to simulate a lost connection. */
class SocketProxy {
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly listenPath: string, private readonly targetPath: string) {}

  async up(): Promise<void> {
    const server = net.createServer((client) => {
      const upstream = net.connect(this.targetPath);
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on('close', () => { this.sockets.delete(s); });
        s.on('error', () => s.destroy());
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.listenPath, resolve); });
  }

  async down(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const s of this.sockets) s.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe.skipIf(!fs.existsSync(MISAO_CLI))('MisaoPaneStream against a real misao daemon', () => {
  let dir: string;
  let daemon: ChildProcess;
  let daemonPid: number;
  let direct: MisaoConnection;
  let viaProxy: MisaoConnection;
  let proxy: SocketProxy;
  const warn = vi.fn();

  async function openPane(script: string): Promise<PaneHandle> {
    const { windowId } = await direct.request('window.create', { workspace: 'azps', name: `w${Math.random().toString(36).slice(2, 6)}` });
    const { paneId } = await direct.request('pane.open', { cmd: ['/bin/sh', '-c', script], windowId });
    return asPaneHandle(paneId);
  }

  function watchMarkers(stream: MisaoPaneStream): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('marker not detected')), 20000);
      stream.on('marker', (kind: string) => { clearTimeout(timer); resolve(kind); });
    });
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azp-'));
    const socketPath = path.join(dir, 'm.sock');
    const proxyPath = path.join(dir, 'p.sock');
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(SOCKET_BYTES_MAX);
    daemon = spawn(process.execPath, [MISAO_CLI, 'serve', '--socket', socketPath, '--data', dir], { stdio: 'ignore' });
    daemonPid = daemon.pid!;
    await vi.waitFor(() => expect(fs.existsSync(socketPath)).toBe(true), { timeout: 10000, interval: 50 });

    const sdk = await import('@misao/sdk');
    direct = new MisaoConnection({ socketPath, sdk, log: { warn } });
    await direct.start();
    await direct.request('workspace.create', { name: 'azps' });
    proxy = new SocketProxy(proxyPath, socketPath);
    await proxy.up();
    viaProxy = new MisaoConnection({ socketPath: proxyPath, sdk, log: { warn } });
    await viaProxy.start();
  });

  afterAll(async () => {
    viaProxy?.close();
    direct?.close();
    await proxy?.down();
    if (daemon && daemon.exitCode === null) {
      const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
      process.kill(daemonPid, 'SIGTERM');
      await exited;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects the done marker a worker prints', async () => {
    const pane = await openPane('sleep 1; echo working; echo AZITO_DONE_1_n1');
    const stream = new MisaoPaneStream(pane, viaProxy);
    stream.setMarkers('AZITO_DONE_1_n1', 'AZITO_QUESTIONS_1_n1');
    stream.enableMarkerDetection();
    const detected = watchMarkers(stream);
    stream.start();
    try {
      await expect(detected).resolves.toBe('phase_complete');
      expect(stream.getBuffer()).toContain('working');
    } finally {
      stream.stop();
    }
  });

  it('still detects the marker printed while the daemon connection was down, once the SDK reconnected', async () => {
    const pane = await openPane('sleep 1; echo started; sleep 4; echo AZITO_DONE_2_n2');
    const stream = new MisaoPaneStream(pane, viaProxy);
    stream.setMarkers('AZITO_DONE_2_n2', 'AZITO_QUESTIONS_2_n2');
    stream.enableMarkerDetection();
    const detected = watchMarkers(stream);
    stream.start();
    try {
      await vi.waitFor(() => expect(stream.getBuffer()).toContain('started'), { timeout: 10000, interval: 50 });
      await proxy.down();
      await vi.waitFor(async () => {
        expect((await direct.request('pane.screen', { paneId: pane })).text).toContain('AZITO_DONE_2_n2');
      }, { timeout: 15000, interval: 100 });
      await proxy.up();
      await expect(detected).resolves.toBe('phase_complete');
    } finally {
      stream.stop();
    }
  });
});
