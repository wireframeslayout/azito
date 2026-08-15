import { describe, it, expect, vi } from 'vitest';
import { TmuxClient } from './TmuxClient';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';

const srv: ServerConfig = { name: 'local', type: 'local' } as ServerConfig;
const remoteSrv: ServerConfig = { name: 'remote', type: 'agent', host: '100.64.1.7' } as ServerConfig;
const PUBLIC_URL = 'http://100.64.1.42:3001';
const LOCAL_URL = 'http://127.0.0.1:3001';
const UI_TOKEN = 'test-ui-token-123';

function makeClient(
  execTmux: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>,
  uiToken: string = UI_TOKEN,
): TmuxClient {
  const factory = {
    getTransport: () => ({ execTmux: vi.fn(execTmux) }),
  } as unknown as TransportFactory;
  return new TmuxClient(factory, PUBLIC_URL, uiToken, LOCAL_URL);
}

function envValue(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-e' && args[i + 1]?.startsWith(`${key}=`)) {
      return args[i + 1].slice(key.length + 1);
    }
  }
  return undefined;
}

describe('TmuxClient AZITO_URL injection', () => {
  it('createSession on a local server uses the loopback URL', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.createSession(srv, 'test-session', { windowName: 'win' });
    expect(envValue(calls[0], 'AZITO_URL')).toBe(LOCAL_URL);
  });

  it('createWindow on a local server uses the loopback URL', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.createWindow(srv, 'test-session', 'win');
    expect(envValue(calls[0], 'AZITO_URL')).toBe(LOCAL_URL);
  });

  // A host does not necessarily reach itself through its public address (with
  // `tailscale serve` on WSL2 the MagicDNS name resolves but the connection to
  // the host's own Tailscale IP never completes), so panes on the hub's machine
  // must be given the loopback URL. Remote servers cannot use loopback at all.
  it('createWindow on a remote server keeps the public URL', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.createWindow(remoteSrv, 'test-session', 'win');
    expect(envValue(calls[0], 'AZITO_URL')).toBe(PUBLIC_URL);
  });

  it('createSession on a remote server keeps the public URL', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.createSession(remoteSrv, 'test-session', { windowName: 'win' });
    expect(envValue(calls[0], 'AZITO_URL')).toBe(PUBLIC_URL);
  });
});

// Issue #28 Phase A後半: TmuxClient no longer injects AZITO_UI_TOKEN
// unconditionally into every window/session it creates — a task pane must
// NOT automatically carry the all-powerful UI token (design v3 §2/§9). Every
// caller now decides its own extraEnv explicitly; `uiTokenEnv()` below is
// the opt-in helper for callers that want the pre-Phase-A default (a plain
// terminal/manual/project window, not a task's — see the doc comment on
// `uiTokenEnv()` itself).
describe('TmuxClient AZITO_UI_TOKEN injection (Issue #28 Phase A後半: no longer unconditional)', () => {
  it('createSession does NOT include -e AZITO_UI_TOKEN unless the caller passes it via extraEnv', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.createSession(srv, 'test-session', { windowName: 'win' });
    expect(envValue(calls[0], 'AZITO_URL')).toBe(LOCAL_URL);
    expect(envValue(calls[0], 'AZITO_UI_TOKEN')).toBeUndefined();
  });

  it('createWindow does NOT include -e AZITO_UI_TOKEN unless the caller passes it via extraEnv', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.createWindow(srv, 'test-session', 'win');
    expect(envValue(calls[0], 'AZITO_URL')).toBe(LOCAL_URL);
    expect(envValue(calls[0], 'AZITO_UI_TOKEN')).toBeUndefined();
  });

  it('createSession/createWindow include -e AZITO_UI_TOKEN when the caller passes uiTokenEnv() as extraEnv', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.createSession(srv, 'test-session', { windowName: 'win', extraEnv: client.uiTokenEnv() });
    await client.createWindow(srv, 'test-session', 'win', { extraEnv: client.uiTokenEnv() });
    // Each call also emits a second `set-window-option` tmux invocation
    // (setWindowStatusFormat) — filter to just the new-session/new-window
    // calls that actually carry the env flags.
    const newSessionCall = calls.find((c) => c[0] === 'new-session')!;
    const newWindowCall = calls.find((c) => c[0] === 'new-window')!;
    expect(envValue(newSessionCall, 'AZITO_UI_TOKEN')).toBe(UI_TOKEN);
    expect(envValue(newWindowCall, 'AZITO_UI_TOKEN')).toBe(UI_TOKEN);
  });

  it('uiTokenEnv() returns an empty object when uiToken is empty', async () => {
    const client = makeClient(async () => ({ stdout: '', stderr: '', code: 0 }), '');
    expect(client.uiTokenEnv()).toEqual({});
  });
});

// Issue #29 review (5th pass), Critical finding 1: uiTokenEnv() itself has
// no way to know which server it's injecting into, so every one of its
// legacy call sites (manual session/window/pane routes,
// WindowRespawnService's non-task fallback) happily injected the hub's
// AZITO_UI_TOKEN into an isolation_intent=1 server's pane too. This is the
// server-aware wrapper those call sites now use instead.
describe('TmuxClient.uiTokenEnvForServer', () => {
  it('returns the legacy uiTokenEnv() for a non-isolated server', async () => {
    const client = makeClient(async () => ({ stdout: '', stderr: '', code: 0 }));
    expect(client.uiTokenEnvForServer(srv)).toEqual({ AZITO_UI_TOKEN: UI_TOKEN });
  });

  it('masks the token with an explicit empty string for an isolation_intent server', async () => {
    const client = makeClient(async () => ({ stdout: '', stderr: '', code: 0 }));
    const isolatedSrv: ServerConfig = { ...remoteSrv, isolationIntent: true };
    expect(client.uiTokenEnvForServer(isolatedSrv)).toEqual({ AZITO_UI_TOKEN: '' });
  });

  it('masks even when the underlying uiToken is empty (still an explicit key, not omitted)', async () => {
    const client = makeClient(async () => ({ stdout: '', stderr: '', code: 0 }), '');
    const isolatedSrv: ServerConfig = { ...remoteSrv, isolationIntent: true };
    expect(client.uiTokenEnvForServer(isolatedSrv)).toEqual({ AZITO_UI_TOKEN: '' });
  });
});
