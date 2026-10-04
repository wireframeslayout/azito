import { describe, it, expect, vi } from 'vitest';
import { formatMuxRef, type MuxDriverKind, type MuxRef } from '@azito/shared';
import { resolveTerminalTarget, terminalPaneOrdinal, type TerminalTargetParams } from './resolveTerminalTarget';
import { AmbiguousWindowKindError, type RawProbeResult } from '../modules/tmux/storedWindowKind';
import { MuxDriverUnavailableError } from '../modules/tmux/MuxCapabilityError';
import type { ServerConfig } from '../modules/servers/Server';
import type { Window } from '../modules/windows/Window';

const TMUX_REF: MuxRef = { kind: 'tmux', workspace: 'sess', window: 'win' };
const MISAO_REF: MuxRef = { kind: 'misao', workspace: 'ws', window: 'w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8' };

const servers: Record<string, ServerConfig> = {
  tmuxsrv: { name: 'tmuxsrv', type: 'local', defaultMux: 'tmux' as const, muxRuntime: 'system' } as ServerConfig,
  misaosrv: { name: 'misaosrv', type: 'local', defaultMux: 'misao' as const, muxRuntime: 'system' } as ServerConfig,
  bothsrv: { name: 'bothsrv', type: 'local', defaultMux: 'tmux' as const, muxRuntime: 'system' } as ServerConfig,
  agentsrv: { name: 'agentsrv', type: 'agent', defaultMux: 'tmux' as const, muxRuntime: 'system' } as ServerConfig,
};
const windows: Record<number, Window> = {
  7: { id: 7, serverName: 'tmuxsrv', tmuxTarget: 'sess:win', muxRef: TMUX_REF } as Window,
  8: { id: 8, serverName: 'misaosrv', tmuxTarget: 'ws:name', muxRef: TMUX_REF } as Window,
  9: { id: 9, serverName: 'misaosrv', tmuxTarget: 'ws:w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8', muxRef: MISAO_REF } as Window,
  11: { id: 11, serverName: 'tmuxsrv', tmuxTarget: 'sess:win' } as Window,
  10: { id: 10, serverName: 'misaosrv', tmuxTarget: 'ws:name' } as Window,
  12: { id: 12, serverName: 'agentsrv', tmuxTarget: 'ws:w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8', muxRef: MISAO_REF } as Window,
};
const BOTH_ID_TARGET = `ws:${MISAO_REF.window}`;
const TMUX_ID_REF: MuxRef = { kind: 'tmux', workspace: 'ws', window: MISAO_REF.window };
// Which muxes each fixture server hosts, and which windows each mux has (a tmux window may carry a misao-id-shaped name).
const kindsOf = (name: string): MuxDriverKind[] => (name === 'bothsrv' ? ['tmux', 'misao'] : name === 'misaosrv' ? ['misao'] : ['tmux']);
let existing: { tmux: string[]; misao: string[] } = { tmux: [], misao: [] };
let down: MuxDriverKind[] = [];
const resolveRefInMux = vi.fn(async (_server: ServerConfig, kind: MuxDriverKind, target: string): Promise<RawProbeResult> => {
  if (down.includes(kind)) return { status: 'unavailable', error: new MuxDriverUnavailableError(kind, 'daemon_unreachable') };
  if (!existing[kind].includes(target)) return { status: 'absent' };
  return { status: 'found', ref: kind === 'misao' ? MISAO_REF : target === BOTH_ID_TARGET ? TMUX_ID_REF : TMUX_REF };
});
const deps = {
  probe: { supportedKinds: (server: ServerConfig) => kindsOf(server.name), resolveRefInMux },
  serverRepo: { findByName: (name: string) => servers[name] ?? null },
  windowRepo: {
    findById: (id: number) => windows[id],
    findByServerAndTarget: (serverName: string, target: string) => Object.values(windows).find((w) => w.serverName === serverName && w.tmuxTarget === target),
  },
};
const params = (p: Partial<TerminalTargetParams>): TerminalTargetParams => ({ serverName: null, windowId: null, ref: null, target: null, ...p });
const encoded = (ref: MuxRef) => encodeURIComponent(formatMuxRef(ref));

describe('resolveTerminalTarget (windowId)', () => {
  it('accepts an old tmux row without a stored ref on a tmux server', async () => {
    expect(await resolveTerminalTarget(params({ windowId: '11' }), deps)).toEqual({ server: servers.tmuxsrv, ref: TMUX_REF });
  });

  it('accepts a row whose ref kind matches its server', async () => {
    expect(await resolveTerminalTarget(params({ windowId: '9' }), deps)).toEqual({ server: servers.misaosrv, ref: MISAO_REF });
  });

  it('accepts a tmux row on a local server whose default mux is misao (a local server hosts both muxes)', async () => {
    expect(await resolveTerminalTarget(params({ windowId: '8' }), deps)).toEqual({ server: servers.misaosrv, ref: TMUX_REF });
    expect(await resolveTerminalTarget(params({ windowId: '10' }), deps)).toEqual({ server: servers.misaosrv, ref: { kind: 'tmux', workspace: 'ws', window: 'name' } });
  });

  it('rejects a misao row on an agent server (it hosts tmux only)', async () => {
    expect(await resolveTerminalTarget(params({ windowId: '12' }), deps)).toBeNull();
  });
});

describe('resolveTerminalTarget', () => {
  it('accepts a ref whose kind matches the server', async () => {
    expect(await resolveTerminalTarget(params({ serverName: 'tmuxsrv', ref: encoded(TMUX_REF) }), deps)).toEqual({ server: servers.tmuxsrv, ref: TMUX_REF });
  });

  it('rejects a misao ref on a tmux-only (agent) server', async () => {
    expect(await resolveTerminalTarget(params({ serverName: 'agentsrv', ref: encoded(MISAO_REF) }), deps)).toBeNull();
  });

  it('accepts a tmux ref on a local misao-default server, and rejects a misao ref on an agent server', async () => {
    expect(await resolveTerminalTarget(params({ serverName: 'misaosrv', ref: encoded(TMUX_REF) }), deps)).toEqual({ server: servers.misaosrv, ref: TMUX_REF });
    expect(await resolveTerminalTarget(params({ serverName: 'agentsrv', ref: encoded(MISAO_REF) }), deps)).toBeNull();
  });

  it('rejects a ref when the server is unknown', async () => {
    expect(await resolveTerminalTarget(params({ serverName: 'nope', ref: encoded(TMUX_REF) }), deps)).toBeNull();
  });

  it('rejects an unparseable ref', async () => {
    expect(await resolveTerminalTarget(params({ serverName: 'tmuxsrv', ref: 'not-json' }), deps)).toBeNull();
  });

  it('resolves by windowId to the window server and ref', async () => {
    expect(await resolveTerminalTarget(params({ windowId: '7' }), deps)).toEqual({ server: servers.tmuxsrv, ref: TMUX_REF });
  });

  it('falls back to the tmux target', async () => {
    expect(await resolveTerminalTarget(params({ serverName: 'tmuxsrv', target: 'sess:win.1' }), deps)).toEqual({ server: servers.tmuxsrv, ref: TMUX_REF });
  });

  it('resolves a target on a misao-only server through the driver', async () => {
    existing = { tmux: [], misao: ['ws:win', BOTH_ID_TARGET] };
    expect(await resolveTerminalTarget(params({ serverName: 'misaosrv', target: 'ws:win.1' }), deps)).toEqual({ server: servers.misaosrv, ref: MISAO_REF });
    expect(await resolveTerminalTarget(params({ serverName: 'misaosrv', target: `${BOTH_ID_TARGET}.2` }), deps)).toEqual({ server: servers.misaosrv, ref: MISAO_REF });
    expect(await resolveTerminalTarget(params({ serverName: 'misaosrv', target: 'ws:other' }), deps)).toBeNull();
  });

  it('reads a target on a tmux-only server as a tmux target, without asking a mux, even with a misao-id-shaped name', async () => {
    resolveRefInMux.mockClear();
    expect(await resolveTerminalTarget(params({ serverName: 'agentsrv', target: `agent-ws:${MISAO_REF.window}.1` }), deps)).toEqual({ server: servers.agentsrv, ref: { ...TMUX_ID_REF, workspace: 'agent-ws' } });
    expect(await resolveTerminalTarget(params({ serverName: 'tmuxsrv', target: 'sess:win' }), deps)).toEqual({ server: servers.tmuxsrv, ref: TMUX_REF });
    expect(resolveRefInMux).not.toHaveBeenCalled();
  });

  describe('on a local server hosting both muxes', () => {
    it('connects a tmux window named like a misao id as tmux', async () => {
      existing = { tmux: [BOTH_ID_TARGET], misao: [] };
      expect(await resolveTerminalTarget(params({ serverName: 'bothsrv', target: `${BOTH_ID_TARGET}.1` }), deps)).toEqual({ server: servers.bothsrv, ref: TMUX_ID_REF });
    });

    it('connects a misao window by its id as misao', async () => {
      existing = { tmux: [], misao: [BOTH_ID_TARGET] };
      expect(await resolveTerminalTarget(params({ serverName: 'bothsrv', target: BOTH_ID_TARGET }), deps)).toEqual({ server: servers.bothsrv, ref: MISAO_REF });
    });

    it('rejects a target that names a window in both muxes (the client must use windowId or ref)', async () => {
      existing = { tmux: [BOTH_ID_TARGET], misao: [BOTH_ID_TARGET] };
      await expect(resolveTerminalTarget(params({ serverName: 'bothsrv', target: BOTH_ID_TARGET }), deps)).rejects.toBeInstanceOf(AmbiguousWindowKindError);
    });

    it('does not guess while a mux is down: a window the other mux does not have is an error, one it has still connects', async () => {
      down = ['misao'];
      try {
        existing = { tmux: [], misao: [BOTH_ID_TARGET] };
        await expect(resolveTerminalTarget(params({ serverName: 'bothsrv', target: BOTH_ID_TARGET }), deps)).rejects.toBeInstanceOf(MuxDriverUnavailableError);
        existing = { tmux: [BOTH_ID_TARGET], misao: [] };
        expect(await resolveTerminalTarget(params({ serverName: 'bothsrv', target: BOTH_ID_TARGET }), deps)).toEqual({ server: servers.bothsrv, ref: TMUX_ID_REF });
      } finally {
        down = [];
      }
    });

    it('returns null for a window neither mux has', async () => {
      existing = { tmux: [], misao: [] };
      expect(await resolveTerminalTarget(params({ serverName: 'bothsrv', target: 'ws:nothing' }), deps)).toBeNull();
    });

    it('uses the stored ref of a registered window without asking the muxes, even when both have it', async () => {
      existing = { tmux: [BOTH_ID_TARGET], misao: [BOTH_ID_TARGET] };
      resolveRefInMux.mockClear();
      windows[20] = { id: 20, serverName: 'bothsrv', tmuxTarget: BOTH_ID_TARGET, muxRef: TMUX_ID_REF } as Window;
      try {
        expect(await resolveTerminalTarget(params({ serverName: 'bothsrv', target: BOTH_ID_TARGET }), deps)).toEqual({ server: servers.bothsrv, ref: TMUX_ID_REF });
        expect(resolveRefInMux).not.toHaveBeenCalled();
      } finally {
        delete windows[20];
      }
    });
  });
});

describe('terminalPaneOrdinal', () => {
  it('prefers the pane param, then the target suffix, then 1', () => {
    expect(terminalPaneOrdinal('3', 'ws:win.2')).toBe(3);
    expect(terminalPaneOrdinal(null, 'ws:win.2')).toBe(2);
    expect(terminalPaneOrdinal(null, 'ws:win')).toBe(1);
    expect(terminalPaneOrdinal(null, null)).toBe(1);
  });
});
