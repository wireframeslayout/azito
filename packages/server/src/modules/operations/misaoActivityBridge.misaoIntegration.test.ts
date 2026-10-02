import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyScreen, splitPromptBox, type MuxRef } from '@azito/shared';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { IWindowRepository, Window } from '../windows/Window';
import type { NotificationBus } from '../notifications/NotificationBus';
import type { ExecuteTaskUseCase } from '../tasks/execution/ExecuteTaskUseCase';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import { MisaoConnection, connectDedicatedMisaoClient } from '../tmux/misao/MisaoConnection';
import { MisaoMuxClient } from '../tmux/misao/MisaoMuxClient';
import { MisaoPaneStateEvents } from '../tmux/misao/misaoPaneStateEvents';
import { MisaoActivityBridge } from './misaoActivityBridge';
import { AgentActivityMonitor } from './AgentActivityMonitor';
import { PaneHandleResolver } from './PaneHandleResolver';

// Drives a real misao daemon started in a throwaway directory (never the resident ~/.misao one).
const MISAO_CLI = process.env.MISAO_CLI ?? path.join(os.homedir(), 'workspace/misao/packages/cli/dist/main.js');
const SOCKET_BYTES_MAX = 107;
const SERVER = { name: 'local', type: 'local', muxRuntime: 'misao' } as ServerConfig;

/** A selection prompt claude's screen rules read as blocked (see the unit tests of AgentActivityMonitor). */
const BLOCKED_SCREEN = '  1. Yes\n  2. No\n  Enter to select · Esc to cancel';
const PLAIN_OUTPUT = 'compiling module 1 of 40 ... ok';

/**
 * Each frame clears the screen and draws `text`, padded with no-op SGR sequences so that a handful of frames
 * clear the daemon's bytes rule (200 bytes within 3 s) — the daemon only judges `working` from output volume.
 */
const FAKE_AGENT = `
const fs = require('node:fs');
const [, , screenFile, mode] = process.argv;
const frame = () => {
  const text = fs.readFileSync(screenFile, 'utf8');
  process.stdout.write('\\x1b[2J\\x1b[H' + '\\x1b[0m'.repeat(24) + text.replace(/\\n/g, '\\r\\n'));
};
frame();
if (mode === 'redraw' || mode === 'finish') setInterval(frame, 500);
else setInterval(() => {}, 1000);
if (mode === 'finish') setTimeout(() => process.exit(0), 5000);
`;

describe.skipIf(!fs.existsSync(MISAO_CLI))('MisaoActivityBridge against a real misao daemon', () => {
  let dir: string;
  let daemon: ChildProcess;
  let daemonPid: number;
  let connection: MisaoConnection;
  let paneStates: MisaoPaneStateEvents;
  let monitor: AgentActivityMonitor;
  const emit = vi.fn();
  const warn = vi.fn();
  const windows: Window[] = [];

  function screenFile(name: string, text: string): string {
    const file = path.join(dir, `${name}.screen`);
    fs.writeFileSync(file, text);
    return file;
  }

  /** Opens a window running the fake agent and registers its `windows` row, as the hub does for an agent window. */
  async function launchAgent(name: string, text: string, mode: 'redraw' | 'once' | 'finish'): Promise<{ target: string; screen: string }> {
    const screen = screenFile(name, text);
    const { windowId } = await connection.request('window.create', { workspace: 'azact', name });
    const ref: MuxRef = { kind: 'misao', workspace: 'azact', window: windowId };
    windows.push({
      id: windows.length + 1, ownerType: 'project', projectId: 1, taskId: null, serverName: SERVER.name, tmuxTarget: windowId,
      label: name, isPrimary: false, windowType: 'agent', workerType: 'claude', workerModel: null, agentSessionId: null,
      launchCommand: null, workingDirectory: null, paneLayout: null, sleeping: false, createdAt: '2026-01-01T00:00:00Z', muxRef: ref,
    });
    await connection.request('pane.open', { cmd: [process.execPath, path.join(dir, 'fake-agent.js'), screen, mode], windowId });
    return { target: windowId, screen };
  }

  function diagnosticsOf(target: string) {
    return monitor.diagnostics().find((d) => d.target === target);
  }

  /** The hub polls on an interval; the test stands in for it by ticking while it waits. */
  async function waitFor(condition: () => boolean, timeout = 25000): Promise<void> {
    await vi.waitFor(async () => {
      await monitor.tick();
      expect(condition()).toBe(true);
    }, { timeout, interval: 300 });
  }

  function stopPayloads(target: string): Array<Record<string, unknown>> {
    return emit.mock.calls.map(([event]) => event.payload).filter((p) => p.target === target && p.running === false);
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aza-'));
    const socketPath = path.join(dir, 'm.sock');
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(SOCKET_BYTES_MAX);
    fs.writeFileSync(path.join(dir, 'fake-agent.js'), FAKE_AGENT);
    daemon = spawn(process.execPath, [MISAO_CLI, 'serve', '--socket', socketPath, '--data', dir], { stdio: 'ignore' });
    daemonPid = daemon.pid!;
    await vi.waitFor(() => expect(fs.existsSync(socketPath)).toBe(true), { timeout: 10000, interval: 50 });

    const sdk = await import('@misao/sdk');
    connection = new MisaoConnection({ socketPath, sdk, log: { warn } });
    const driver = new MisaoMuxClient(connection, { shell: '/bin/bash', onChange: () => {}, log: { warn }, connectAttachClient: () => connectDedicatedMisaoClient(sdk, socketPath) });
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('misao', driver, () => connection.availability());
    await connection.start();
    await connection.request('workspace.create', { name: 'azact' });

    const windowRepo = {
      findAll: () => windows,
      findById: (id: number) => windows.find((w) => w.id === id),
      findByServerAndRef: (serverName: string, ref: MuxRef) => windows.find((w) => w.serverName === serverName && w.muxRef?.window === ref.window),
    } as unknown as IWindowRepository;
    const serverRepo = { findByName: (name: string) => (name === SERVER.name ? SERVER : null), findAll: () => [SERVER] } as unknown as IServerRepository;
    const resolver = new PaneHandleResolver(registry, windowRepo, serverRepo);
    monitor = new AgentActivityMonitor(
      { getRunning: () => ({}) } as unknown as ExecuteTaskUseCase,
      windowRepo, registry, serverRepo, { emit } as unknown as NotificationBus,
    );
    const bridge = new MisaoActivityBridge({ resolver, monitor, listServerNames: () => [SERVER.name], log: { warn } });
    paneStates = new MisaoPaneStateEvents(connection, (state) => bridge.handleState(state), () => bridge.handleDisconnected(), { warn });
    await paneStates.start();
  });

  afterAll(async () => {
    paneStates?.stop();
    connection?.close();
    if (daemon && daemon.exitCode === null) {
      const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
      process.kill(daemonPid, 'SIGTERM');
      await exited;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the screens this test draws are what claude\'s rules read as blocked / not blocked', () => {
    expect(classifyScreen('claude', splitPromptBox(BLOCKED_SCREEN.split('\n')))).toBe('blocked');
    expect(classifyScreen('claude', splitPromptBox(PLAIN_OUTPUT.split('\n')))).not.toBe('blocked');
  });

  it('a command that prints and exits goes working, then ends as a completion decided by tier0_mux', async () => {
    const { target } = await launchAgent('finish', PLAIN_OUTPUT, 'finish');

    await waitFor(() => emit.mock.calls.some(([e]) => e.payload.target === target && e.payload.running === true));
    expect(diagnosticsOf(target)).toEqual(expect.objectContaining({ decidedBy: 'tier0_mux' }));

    await waitFor(() => stopPayloads(target).length > 0);
    expect(stopPayloads(target)[0]).toEqual(expect.objectContaining({ reason: 'completed' }));
  });

  it('a process that exits while its last screen matches the blocked rules still ends as a completion', async () => {
    const { target } = await launchAgent('exitblocked', BLOCKED_SCREEN, 'finish');

    await waitFor(() => emit.mock.calls.some(([e]) => e.payload.target === target && e.payload.running === true));
    await waitFor(() => stopPayloads(target).length > 0);
    expect(stopPayloads(target)[0]).toEqual(expect.objectContaining({ reason: 'completed' }));
    expect(diagnosticsOf(target)?.refinedBy).toBeUndefined();
  });

  it('a pane that keeps redrawing a blocked screen is working in the daemon, blocked in the hub, still tier0_mux', async () => {
    const { target, screen } = await launchAgent('redraw', BLOCKED_SCREEN, 'redraw');

    await waitFor(() => diagnosticsOf(target)?.mux?.status === 'working');
    expect(diagnosticsOf(target)).toEqual(expect.objectContaining({ decidedBy: 'tier0_mux', refinedBy: 'tier2_title', state: 'blocked' }));
    expect(monitor.snapshot().find((e) => e.target === target)).toEqual(expect.objectContaining({ running: true, status: 'blocked' }));

    // The prompt goes away and ordinary output continues: the key is working again, not blocked.
    fs.writeFileSync(screen, PLAIN_OUTPUT);
    await waitFor(() => diagnosticsOf(target)?.state === 'working');
    expect(diagnosticsOf(target)?.refinedBy).toBeUndefined();
    expect(monitor.snapshot().find((e) => e.target === target)?.status).toBeUndefined();
  });

  it('a blocked screen drawn once and then still is idle in the daemon, blocked in the hub, and announces no completion', async () => {
    const { target } = await launchAgent('once', BLOCKED_SCREEN, 'once');

    await waitFor(() => diagnosticsOf(target)?.mux?.status === 'idle');
    await waitFor(() => diagnosticsOf(target)?.state === 'blocked');
    expect(diagnosticsOf(target)).toEqual(expect.objectContaining({ decidedBy: 'tier0_mux', refinedBy: 'tier2_title' }));
    expect(stopPayloads(target)).toEqual([]);
  });
});
