import { describe, it, expect, vi } from 'vitest';
import { resolveWindowById, resolveRefFromParam, closePaneInWindow } from './windowPaneOps';
import type { IMuxClient, PaneLocation } from '../tmux/IMuxClient';
import type { ServerConfig } from '../servers/Server';
import type { MuxRef } from '@azito/shared';
import type { Window, IWindowRepository } from './Window';

const makeWindow = (overrides: Partial<Window> = {}): Window => ({
  id: 1,
  ownerType: 'project',
  projectId: 1,
  taskId: null,
  serverName: 'local',
  tmuxTarget: 'session:win-1',
  label: null,
  isPrimary: false,
  windowType: 'agent',
  workerType: 'claude',
  workerModel: null,
  agentSessionId: null,
  launchCommand: null,
  workingDirectory: null,
  paneLayout: null,
  sleeping: false,
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('resolveWindowById', () => {
  it('returns window and ref when found', () => {
    const win = makeWindow({ muxRef: { kind: 'tmux', workspace: 'session', window: 'win-1' } });
    const repo = { findById: (id: number) => id === 1 ? win : undefined } as unknown as IWindowRepository;
    const result = resolveWindowById(repo, 1);
    expect(result.window).toBe(win);
    expect(result.ref).toEqual({ kind: 'tmux', workspace: 'session', window: 'win-1' });
  });

  it('derives ref from tmuxTarget when muxRef is absent', () => {
    const win = makeWindow();
    const repo = { findById: () => win } as unknown as IWindowRepository;
    const result = resolveWindowById(repo, 1);
    expect(result.ref).toEqual({ kind: 'tmux', workspace: 'session', window: 'win-1' });
  });

  it('throws 404 when not found', () => {
    const repo = { findById: () => undefined } as unknown as IWindowRepository;
    expect(() => resolveWindowById(repo, 999)).toThrow('Window not found');
    try {
      resolveWindowById(repo, 999);
    } catch (e: any) {
      expect(e.statusCode).toBe(404);
    }
  });
});

describe('resolveRefFromParam', () => {
  it('decodes a valid encoded ref', () => {
    const encoded = encodeURIComponent('{"kind":"tmux","workspace":"s","window":"w"}');
    const ref = resolveRefFromParam(encoded);
    expect(ref).toEqual({ kind: 'tmux', workspace: 's', window: 'w' });
  });

  it('throws 400 on invalid ref', () => {
    expect(() => resolveRefFromParam('not-json')).toThrow('Invalid ref parameter');
    try {
      resolveRefFromParam('not-json');
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
    }
  });
});

describe('closePaneInWindow with a handle', () => {
  const server = { name: 'm' } as ServerConfig;
  const ref: MuxRef = { kind: 'misao', workspace: 'ws', window: 'w_A' };
  const HANDLE = 'p_00000000000000000000000001';
  const OK = { stdout: '', stderr: '', code: 0 };

  function driver(location: PaneLocation | Error): { client: IMuxClient; closePane: ReturnType<typeof vi.fn> } {
    const closePane = vi.fn(async () => OK);
    const client = {
      closePane,
      locatePane: vi.fn(async () => { if (location instanceof Error) throw location; return location; }),
      resolvePane: vi.fn(async () => HANDLE),
    } as unknown as IMuxClient;
    return { client, closePane };
  }
  const found: PaneLocation = { status: 'found', ref, ordinal: 1 };

  it('closes a pane that belongs to the window', async () => {
    const { client, closePane } = driver(found);
    await closePaneInWindow(client, server, ref, { ordinal: 1, handle: HANDLE });
    expect(closePane).toHaveBeenCalledWith(server, HANDLE);
  });

  it('succeeds without closing anything when the pane is verified absent', async () => {
    const { client, closePane } = driver({ status: 'absent' });
    await closePaneInWindow(client, server, ref, { ordinal: 1, handle: HANDLE });
    expect(closePane).not.toHaveBeenCalled();
  });

  it('refuses a pane of another window with 404', async () => {
    const { client, closePane } = driver({ status: 'found', ref: { ...ref, window: 'w_B' }, ordinal: 1 });
    await expect(closePaneInWindow(client, server, ref, { ordinal: 1, handle: HANDLE })).rejects.toMatchObject({ statusCode: 404 });
    expect(closePane).not.toHaveBeenCalled();
  });

  it('refuses a malformed handle with 400', async () => {
    const { client } = driver(found);
    await expect(closePaneInWindow(client, server, ref, { ordinal: 1, handle: '%3' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('answers 503 when the pane cannot be verified, never "already gone"', async () => {
    const { client, closePane } = driver({ status: 'unknown' });
    await expect(closePaneInWindow(client, server, ref, { ordinal: 1, handle: HANDLE })).rejects.toMatchObject({ statusCode: 503 });
    expect(closePane).not.toHaveBeenCalled();
  });

  it('falls back to the ordinal when no handle is given', async () => {
    const { client, closePane } = driver(found);
    await closePaneInWindow(client, server, ref, { ordinal: 1 });
    expect(closePane).toHaveBeenCalledWith(server, HANDLE);
  });
});
