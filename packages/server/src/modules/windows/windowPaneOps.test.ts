import { describe, it, expect } from 'vitest';
import { resolveWindowById, resolveRefFromParam } from './windowPaneOps';
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
