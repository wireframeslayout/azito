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

describe('TmuxClient AZITO_UI_TOKEN injection', () => {
  it('createSession includes -e AZITO_UI_TOKEN=<uiToken> alongside AZITO_URL', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.createSession(srv, 'test-session', { windowName: 'win' });
    expect(envValue(calls[0], 'AZITO_URL')).toBe(LOCAL_URL);
    expect(envValue(calls[0], 'AZITO_UI_TOKEN')).toBe(UI_TOKEN);
  });

  it('createWindow includes -e AZITO_UI_TOKEN=<uiToken> alongside AZITO_URL', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.createWindow(srv, 'test-session', 'win');
    expect(envValue(calls[0], 'AZITO_URL')).toBe(LOCAL_URL);
    expect(envValue(calls[0], 'AZITO_UI_TOKEN')).toBe(UI_TOKEN);
  });

  it('does not inject -e AZITO_UI_TOKEN when uiToken is empty', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    }, '');
    await client.createSession(srv, 'test-session', { windowName: 'win' });
    expect(envValue(calls[0], 'AZITO_UI_TOKEN')).toBeUndefined();
  });
});
