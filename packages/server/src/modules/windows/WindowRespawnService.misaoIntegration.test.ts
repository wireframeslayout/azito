import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'events';
import { KeyedMutex } from '../../shared/keyedMutex';
import type { ServerConfig } from '../servers/Server';
import type { Task } from '../tasks/Task';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import { MisaoConnection, connectDedicatedMisaoClient } from '../tmux/misao/MisaoConnection';
import { MisaoMuxClient } from '../tmux/misao/MisaoMuxClient';
import { muxWindowTarget } from '../tmux/muxWindowTarget';
import { taskWindowRef } from '../tmux/windowIdentity';
import type { Window } from './Window';
import { WindowRespawnService } from './WindowRespawnService';

// Drives a real misao daemon started in a throwaway directory (never the resident ~/.misao one).
const MISAO_CLI = process.env.MISAO_CLI ?? path.join(os.homedir(), 'workspace/misao/packages/cli/dist/main.js');
const SOCKET_BYTES_MAX = 107;
const WORKSPACE = 'wrs-ws';
const DISPLAY_NAME = 'task-7--ab12';
const server = {
  name: 'misao-it', type: 'local', defaultMux: 'misao' as const, muxRuntime: 'system', host: null, agentPort: null, agentToken: null, agentVersion: null,
  sshHost: null, sshHostFingerprint: null, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null,
  isolationCleanupReport: null, createdAt: '2026-01-01T00:00:00Z',
} as ServerConfig;

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 7, projectId: 1, unitId: 10, serverName: null, title: 'T', description: null, status: 'in_progress', currentPhase: null,
    selfReviewCount: 0, priority: 0, tmuxWindow: null, selfReviewMaxAttempts: null, requirePlanApproval: false, source: 'local',
    sourceRef: null, worktreePath: null, worktreeBranch: null, baseBranch: 'main', targetBranch: null, skipPr: false, workingDirectory: null,
    branch: null, planMarkdown: null, pendingQuestions: null, changedFiles: null, summaryJson: null, prUrl: null, agentSessionId: null,
    inputTrust: 'trusted', executionApprovedFingerprintHash: null, pendingOperation: null, pendingOperationWindowId: null,
    pendingOperationPriorStatus: null, pendingFollowUpBody: null, pendingFollowUpPhases: null, sleepAfterPush: null,
    createdByKind: 'operator', createdById: null, createdViaGeneration: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe.skipIf(!fs.existsSync(MISAO_CLI))('WindowRespawnService against a real misao daemon', () => {
  let dir: string;
  let daemon: ChildProcess;
  let daemonPid: number;
  let connection: MisaoConnection;
  let driver: MisaoMuxClient;
  let service: WindowRespawnService;
  let row: Window;
  let task: Task;
  const warn = vi.fn();

  async function windowsOfWorkspace(): Promise<Array<{ id: string; name: string }>> {
    const workspaces = await driver.listWorkspaces(server);
    return (workspaces.find((w) => w.name === WORKSPACE)?.windows ?? []).map((w) => ({ id: w.ref?.window ?? '', name: w.name }));
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrs-'));
    const socketPath = path.join(dir, 'm.sock');
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(SOCKET_BYTES_MAX);
    daemon = spawn(process.execPath, [MISAO_CLI, 'serve', '--socket', socketPath, '--data', dir], { stdio: 'ignore' });
    daemonPid = daemon.pid!;
    await vi.waitFor(() => expect(fs.existsSync(socketPath)).toBe(true), { timeout: 10000, interval: 50 });

    const sdk = await import('@misao/sdk');
    connection = new MisaoConnection({ socketPath, sdk, log: { warn } });
    driver = new MisaoMuxClient(connection, { shell: '/bin/bash', onChange: vi.fn(), log: { warn }, hubEnv: { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh-token' }, connectAttachClient: () => connectDedicatedMisaoClient(sdk, { socketPath }) });
    await connection.start();
    const registry = new MuxDriverRegistry();
    registry.register('misao', driver, () => connection.availability());

    // A sleeping task window: its misao window was closed when it went to sleep, the row still names the old id.
    const opened = await driver.openWorkspace(server, WORKSPACE, { windowName: DISPLAY_NAME, exactName: true });
    row = {
      id: 1, ownerType: 'task', projectId: null, taskId: 7, serverName: server.name, tmuxTarget: muxWindowTarget(opened.ref), muxRef: opened.ref,
      label: DISPLAY_NAME, isPrimary: true, windowType: 'terminal', workerType: null, workerModel: null, agentSessionId: null, launchCommand: null,
      workingDirectory: null, paneLayout: null, sleeping: true, createdAt: '2026-01-01T00:00:00Z',
    };
    task = makeTask({ tmuxWindow: opened.ref.window });
    await driver.closeWindow(server, opened.ref);

    const windowRepo = {
      findById: () => row,
      findByTask: () => [row],
      update: (_id: number, data: Partial<Window>) => { row = { ...row, ...data }; },
    };
    const taskRepo = {
      findById: () => task,
      update: (_id: number, data: Partial<Task>) => { task = { ...task, ...data }; },
      updateStatus: vi.fn(),
    };
    service = new WindowRespawnService(
      windowRepo as never,
      registry,
      {} as never,
      taskRepo as never,
      { findById: () => ({ id: 10, name: 'u', unitType: 'devops', workerType: null, workerModel: null, workerExecutionMode: 'tmux-pipe', workerRuntime: 'tui' }) } as never,
      { clearExitMarker: vi.fn(), issueLaunch: vi.fn(() => undefined) } as never,
      { find: () => null, findByProject: () => [] } as never,
      { findById: () => null } as never,
      { getTransport: () => ({}) } as never,
      { append: vi.fn() } as never,
      { get: () => undefined, getOrThrow: () => { throw new Error('not used'); } } as never,
      { findByName: () => null, findDefaultForTag: () => null, list: () => [] } as never,
      { findByName: () => server } as never,
      { findByProject: () => [] } as never,
      new EventEmitter(),
      { buildEnvForNewWindow: () => ({ env: { AZITO_TASK_ID: '7' }, tokenId: 5 }), buildEnvForSecondaryWindow: () => ({}), revokeGeneration: vi.fn(), revokeForDestroyedWindow: vi.fn() } as never,
      new KeyedMutex(),
      true,
      () => ({}),
      undefined,
    );
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

  it('wakes a sleeping task window under its display name, with tmux_target, mux_ref and task.tmuxWindow all naming the new window id', async () => {
    const oldRef = row.muxRef!;
    expect(await driver.windowExists(server, oldRef)).toBe(false);

    const result = await service.wakeWindow(1, server.name, { skipAgentLaunch: true, gateAlreadyEnforced: true, inLockGate: () => {} });

    const newRef = row.muxRef!;
    expect(newRef.window).not.toBe(oldRef.window);
    expect(result.tmuxTarget).toBe(muxWindowTarget(newRef));
    expect(row.tmuxTarget).toBe(muxWindowTarget(newRef));
    expect(row.label).toBe(DISPLAY_NAME);
    expect(row.sleeping).toBe(false);
    expect(task.tmuxWindow).toBe(newRef.window);
    expect(await windowsOfWorkspace()).toEqual([{ id: newRef.window, name: DISPLAY_NAME }]);
  });

  it('lets the follow-up find that window by its id and reuse it', async () => {
    const ref = taskWindowRef(task, row, WORKSPACE, 'misao')!;

    expect(ref.window).toBe(task.tmuxWindow);
    expect(await driver.windowExists(server, ref)).toBe(true);
    expect((await driver.listPanesByRef(server, ref)).length).toBeGreaterThan(0);
  });

  it('respawns a live window by closing the old one by id first, leaving exactly one window', async () => {
    const before = row.muxRef!;

    await service.respawn(1, server, { skipAgentLaunch: true, gateAlreadyEnforced: true, inLockGate: () => {} });

    const after = row.muxRef!;
    expect(after.window).not.toBe(before.window);
    expect(await driver.windowExists(server, before)).toBe(false);
    expect(await windowsOfWorkspace()).toEqual([{ id: after.window, name: DISPLAY_NAME }]);
    expect(task.tmuxWindow).toBe(after.window);
  });
});
