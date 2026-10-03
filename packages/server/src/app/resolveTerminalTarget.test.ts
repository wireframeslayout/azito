import { describe, it, expect } from 'vitest';
import { formatMuxRef, type MuxRef } from '@azito/shared';
import { resolveTerminalTarget, type TerminalTargetParams } from './resolveTerminalTarget';
import type { ServerConfig } from '../modules/servers/Server';
import type { Window } from '../modules/windows/Window';

const TMUX_REF: MuxRef = { kind: 'tmux', workspace: 'sess', window: 'win' };
const MISAO_REF: MuxRef = { kind: 'misao', workspace: 'ws', window: 'w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8' };

const servers: Record<string, ServerConfig> = {
  tmuxsrv: { name: 'tmuxsrv', muxRuntime: 'system' } as ServerConfig,
  misaosrv: { name: 'misaosrv', muxRuntime: 'misao' } as ServerConfig,
};
const windows: Record<number, Window> = {
  7: { id: 7, serverName: 'tmuxsrv', tmuxTarget: 'sess:win', muxRef: TMUX_REF } as Window,
  8: { id: 8, serverName: 'misaosrv', tmuxTarget: 'ws:name', muxRef: TMUX_REF } as Window,
  9: { id: 9, serverName: 'misaosrv', tmuxTarget: 'ws:w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8', muxRef: MISAO_REF } as Window,
  10: { id: 10, serverName: 'misaosrv', tmuxTarget: 'ws:name' } as Window,
};
const deps = {
  serverRepo: { findByName: (name: string) => servers[name] ?? null },
  windowRepo: { findById: (id: number) => windows[id] },
};
const params = (p: Partial<TerminalTargetParams>): TerminalTargetParams => ({ serverName: null, windowId: null, ref: null, target: null, ...p });
const encoded = (ref: MuxRef) => encodeURIComponent(formatMuxRef(ref));

describe('resolveTerminalTarget (windowId)', () => {
  it('accepts a row whose ref kind matches its server', () => {
    expect(resolveTerminalTarget(params({ windowId: '9' }), deps)).toEqual({ server: servers.misaosrv, ref: MISAO_REF });
  });

  it('rejects a row holding a tmux ref on a misao server', () => {
    expect(resolveTerminalTarget(params({ windowId: '8' }), deps)).toBeNull();
  });

  it('rejects a ref-less row on a misao server (its target would synthesise a tmux ref)', () => {
    expect(resolveTerminalTarget(params({ windowId: '10' }), deps)).toBeNull();
  });
});

describe('resolveTerminalTarget', () => {
  it('accepts a ref whose kind matches the server', () => {
    expect(resolveTerminalTarget(params({ serverName: 'tmuxsrv', ref: encoded(TMUX_REF) }), deps)).toEqual({ server: servers.tmuxsrv, ref: TMUX_REF });
  });

  it('rejects a misao ref on a tmux server', () => {
    expect(resolveTerminalTarget(params({ serverName: 'tmuxsrv', ref: encoded(MISAO_REF) }), deps)).toBeNull();
  });

  it('rejects a tmux ref on a misao server', () => {
    expect(resolveTerminalTarget(params({ serverName: 'misaosrv', ref: encoded(TMUX_REF) }), deps)).toBeNull();
  });

  it('rejects a ref when the server is unknown', () => {
    expect(resolveTerminalTarget(params({ serverName: 'nope', ref: encoded(TMUX_REF) }), deps)).toBeNull();
  });

  it('rejects an unparseable ref', () => {
    expect(resolveTerminalTarget(params({ serverName: 'tmuxsrv', ref: 'not-json' }), deps)).toBeNull();
  });

  it('resolves by windowId to the window server and ref', () => {
    expect(resolveTerminalTarget(params({ windowId: '7' }), deps)).toEqual({ server: servers.tmuxsrv, ref: TMUX_REF });
  });

  it('falls back to the tmux target', () => {
    expect(resolveTerminalTarget(params({ serverName: 'tmuxsrv', target: 'sess:win.1' }), deps)).toEqual({ server: servers.tmuxsrv, ref: TMUX_REF });
  });
});
