import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MuxRef, PaneHandle, PaneOrdinal } from '@azito/shared';
import type { ServerConfig } from '../../servers/Server';
import type { IServerRepository } from '../../servers/Server';
import type { IWindowRepository, Window } from '../../windows/Window';
import { WindowInputService } from '../../transcripts/WindowInputService';
import { MuxDriverRegistry } from '../MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../MuxCapabilityError';
import { MisaoConnection, connectDedicatedMisaoClient } from './MisaoConnection';
import { MisaoMuxClient } from './MisaoMuxClient';
import { selectLocalMisaoServers } from './misaoDriver';
import { CHANGE_COALESCE_MS } from './misaoChangeEvents';

// Drives a real misao daemon started in a throwaway directory (never the resident ~/.misao one).
const MISAO_CLI = process.env.MISAO_CLI ?? path.join(os.homedir(), 'workspace/misao/packages/cli/dist/main.js');
const server = { name: 'local', type: 'local', muxRuntime: 'misao' } as ServerConfig;
const SOCKET_BYTES_MAX = 107;

describe.skipIf(!fs.existsSync(MISAO_CLI))('MisaoMuxClient against a real misao daemon', () => {
  let dir: string;
  let daemon: ChildProcess;
  let daemonPid: number;
  let connection: MisaoConnection;
  let client: MisaoMuxClient;
  const onChange = vi.fn();
  const warn = vi.fn();

  let ref1: MuxRef;
  let ref2: MuxRef;
  let firstPane: PaneHandle;

  async function waitForScreen(handle: PaneHandle, text: string): Promise<void> {
    await vi.waitFor(async () => {
      expect((await client.captureScreen(server, handle)).stdout).toContain(text);
    }, { timeout: 10000, interval: 100 });
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azm-'));
    const socketPath = path.join(dir, 'm.sock');
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(SOCKET_BYTES_MAX);
    daemon = spawn(process.execPath, [MISAO_CLI, 'serve', '--socket', socketPath, '--data', dir], { stdio: 'ignore' });
    daemonPid = daemon.pid!;
    await vi.waitFor(() => expect(fs.existsSync(socketPath)).toBe(true), { timeout: 10000, interval: 50 });

    const sdk = await import('@misao/sdk');
    connection = new MisaoConnection({ socketPath, sdk, log: { warn } });
    client = new MisaoMuxClient(connection, { shell: '/bin/bash', onChange, log: { warn }, connectAttachClient: () => connectDedicatedMisaoClient(sdk, socketPath) });
    await connection.start();
    expect(connection.availability()).toEqual({ available: true });
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

  it('opens a workspace with a first window and a shell pane', async () => {
    const opened = await client.openWorkspace(server, 'azm-ws', { windowName: 'main', exactName: true });
    ref1 = opened.ref;
    expect(ref1).toMatchObject({ kind: 'misao', workspace: 'azm-ws' });
    expect(ref1.window).toMatch(/^w_/);
    const [ws] = await client.listWorkspaces(server);
    expect(ws).toMatchObject({ name: 'azm-ws', windowCount: 1 });
    expect(ws.windows[0]).toMatchObject({ name: 'main', ref: ref1 });
    expect(ws.windows[0].panes).toHaveLength(1);
    await expect(client.openWorkspace(server, 'azm-ws')).rejects.toThrow(/already exists/);
    expect(await client.windowExists(server, ref1)).toBe(true);
  });

  it('opens a second window, splits a pane, and numbers panes in creation order', async () => {
    ({ ref: ref2 } = await client.openWindow(server, 'azm-ws', 'second', { exactName: true }));
    expect(await client.resolveRef(server, 'azm-ws:second')).toEqual(ref2);
    expect(await client.resolveRef(server, ref2.window)).toEqual(ref2);

    firstPane = await client.resolvePane(server, ref1, 1);
    const split = await client.splitPaneByHandle(server, firstPane, 'h');
    const panes = await client.listPanesByRef(server, ref1);
    expect(panes.map((p) => p.ordinal)).toEqual([1, 2]);
    expect(panes[0].handle).toBe(firstPane);
    expect(panes[1].handle).toBe(split.handle);
    expect(await client.refFromPaneHandle(server, split.handle)).toEqual({ ref: ref1, ordinal: 2 });
    expect((await client.listPanesByRef(server, ref2))).toHaveLength(1);

    const all = await client.listAllPanes(server);
    expect(all).toHaveLength(3);
    expect(all.filter((p) => p.ref?.window === ref1.window).map((p) => p.paneIndex)).toEqual([1, 2]);
    expect(all.every((p) => p.sessionName === 'azm-ws')).toBe(true);
  });

  it('lists 1-based indexes that resolve and attach as ordinals as-is', async () => {
    const [workspace] = await client.listWorkspaces(server);
    expect(workspace.windows.map((w) => w.index)).toEqual([1, 2]);
    for (const window of workspace.windows) {
      const handles = await client.listPanesByRef(server, window.ref!);
      expect(window.panes.map((p) => p.index)).toEqual(handles.map((h) => h.ordinal));
      for (const pane of window.panes) {
        const ordinal = pane.index as PaneOrdinal;
        expect(await client.resolvePane(server, window.ref!, ordinal)).toBe(handles.find((h) => h.ordinal === ordinal)?.handle);
        const stream = await client.openTerminal(server, window.ref!, ordinal, 80, 24);
        stream.close();
      }
    }
  });

  it('types into a pane and reads the screen back', async () => {
    await client.sendTextToHandle(server, firstPane, 'echo azito-$((40+2))');
    await client.sendKeysToHandle(server, firstPane, ['Enter']);
    await waitForScreen(firstPane, 'azito-42');
    expect(await client.probePane(server, firstPane)).toEqual({ alive: true, verified: true });
  });

  it('reports pid, foreground command and window activity', async () => {
    expect(await client.panePidByHandle(server, firstPane)).toBeGreaterThan(0);
    expect(await client.paneCommandByHandle(server, firstPane)).toBe('bash');
    expect(await client.windowActivity(server, ref1)).toBeGreaterThan(0);
    expect((await client.measurePanePids(server)).map((p) => p.ref.window)).toContain(ref1.window);
  });

  it('stamps hub labels on every pane of a window', async () => {
    await client.labelWindowPanes(server, ref1, { windowId: 806, taskId: 448 });
    const panes = await client.listPanesByRef(server, ref1);
    for (const pane of panes) {
      const info = await connection.request('pane.info', { paneId: pane.handle });
      expect(info.labels).toMatchObject({ origin: 'hub', name: 'main', windowId: '806', task: '448' });
    }
    const other = await connection.request('pane.info', { paneId: await client.resolvePane(server, ref2, 1) });
    expect(other.labels).toEqual({ origin: 'hub', name: 'second' });
  });

  it('renames a window and a workspace', async () => {
    expect(await client.renameWindowByRef(server, ref2, 'second-renamed')).toMatchObject({ code: 0 });
    expect(await client.renameWorkspace(server, 'azm-ws', 'azm-ws2')).toMatchObject({ code: 0 });
    const [ws] = await client.listWorkspaces(server);
    expect(ws.name).toBe('azm-ws2');
    expect(ws.windows.map((w) => w.name)).toEqual(['main', 'second-renamed']);
    expect(await client.renameWorkspace(server, 'azm-ws', 'x')).toMatchObject({ code: 1 });
    ref1 = { ...ref1, workspace: 'azm-ws2' };
    ref2 = { ...ref2, workspace: 'azm-ws2' };
  });

  it('keeps secret env out of pane.info, pane.list and persistence.json while still injecting it', async () => {
    const secretKey = 'AZITO_TASK_TOKEN';
    const splitKey = 'AZITO_SPLIT_SECRET';
    const secret = 'azm-secret-value-9f3c1';
    const splitSecret = 'azm-split-secret-value-7b2d4';
    const { ref } = await client.openWindow(server, 'azm-ws2', 'secret', { exactName: true, extraEnv: { [secretKey]: secret } });
    const pane = await client.resolvePane(server, ref, 1);
    const split = await client.splitPaneByHandle(server, pane, 'h', { [splitKey]: splitSecret });

    // Injected into the child (the expanded length only appears once the shell evaluated it)...
    await client.sendTextToHandle(server, pane, 'echo env-len-${#' + secretKey + '}');
    await client.sendKeysToHandle(server, pane, ['Enter']);
    await waitForScreen(pane, `env-len-${secret.length}`);
    await client.sendTextToHandle(server, split.handle, 'echo env-len-${#' + splitKey + '}');
    await client.sendKeysToHandle(server, split.handle, ['Enter']);
    await waitForScreen(split.handle, `env-len-${splitSecret.length}`);

    // ...but never exposed or persisted.
    const exposed = JSON.stringify([
      await connection.request('pane.info', { paneId: pane }),
      await connection.request('pane.info', { paneId: split.handle }),
      await connection.request('pane.list', {}),
    ]);
    for (const leaked of [secretKey, secret, splitKey, splitSecret]) expect(exposed).not.toContain(leaked);
    const persisted = fs.readFileSync(path.join(dir, 'persistence.json'), 'utf8');
    expect(persisted).toContain(ref.window);
    for (const leaked of [secretKey, secret, splitKey, splitSecret]) expect(persisted).not.toContain(leaked);
    await client.closeWindow(server, ref);
  });

  it('delivers input to registered windows through WindowInputService, and only to their own panes', async () => {
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('misao', client);
    const window = { id: 7, serverName: 'local', tmuxTarget: '', muxRef: ref1, workerType: null } as unknown as Window;
    const service = new WindowInputService(
      { findById: (id: number) => (id === 7 ? window : undefined) } as unknown as IWindowRepository,
      registry,
      { findByName: () => server } as unknown as IServerRepository,
    );
    const otherPane = await client.resolvePane(server, ref2, 1);

    expect(await service.sendInput(7, firstPane, 'echo azito-input-ok')).toBe('ok');
    await waitForScreen(firstPane, 'azito-input-ok');
    expect(await service.resolvePaneIndex(7, firstPane)).toBe(1);
    expect(await service.sendInput(7, otherPane, 'echo must-not-arrive')).toBe('pane_not_found');
    expect(await service.resolvePaneIndex(7, otherPane)).toBe('pane_not_found');
    expect(await service.sendSignal(7, firstPane, 'key', '1')).toBe('ok');
    expect((await client.captureScreen(server, otherPane)).stdout).not.toContain('must-not-arrive');
  });

  it('notifies on changes once change hooks are installed', async () => {
    expect(selectLocalMisaoServers([server])).toHaveLength(1);
    await client.installChangeHooks(server);
    onChange.mockClear();
    await client.openWindow(server, 'azm-ws2', 'third', { exactName: true });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('local'), { timeout: CHANGE_COALESCE_MS * 10 + 2000, interval: 50 });
    client.uninstallChangeHooks(server);
  });

  it('closes a pane, a window and a workspace', async () => {
    const panes = await client.listPanesByRef(server, ref1);
    expect(await client.closePane(server, panes[1].handle)).toMatchObject({ code: 0 });
    await vi.waitFor(async () => expect(await client.listPanesByRef(server, ref1)).toHaveLength(1));
    expect(await client.closePane(server, panes[1].handle)).toMatchObject({ code: 1, alreadyGone: true });
    expect(await client.probePane(server, panes[1].handle)).toEqual({ alive: false, verified: true });

    expect(await client.closeWindow(server, ref2)).toMatchObject({ code: 0 });
    expect(await client.windowExists(server, ref2)).toBe(false);
    expect(await client.closeWindow(server, ref2)).toMatchObject({ code: 1, alreadyGone: true });
    expect(await client.closeWorkspace(server, 'azm-ws2')).toMatchObject({ code: 0 });
    expect(await client.closeWorkspace(server, 'azm-ws2')).toMatchObject({ code: 1, alreadyGone: true });
    expect(await client.listWorkspaces(server)).toEqual([]);
    expect(await client.listAllPanes(server)).toEqual([]);
  });

  it('reports daemon_unreachable once the daemon is gone', async () => {
    const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
    process.kill(daemonPid, 'SIGTERM');
    await exited;
    await vi.waitFor(async () => {
      await expect(client.listWorkspaces(server)).rejects.toMatchObject({ name: 'MuxDriverUnavailableError', reason: 'daemon_unreachable' });
    }, { timeout: 10000, interval: 100 });
    await expect(client.listWorkspaces(server)).rejects.toBeInstanceOf(MuxDriverUnavailableError);
    expect(connection.availability()).toEqual({ available: false, reason: 'daemon_unreachable' });
    expect(await client.probePane(server, firstPane)).toEqual({ alive: false, verified: false });
  });
});
