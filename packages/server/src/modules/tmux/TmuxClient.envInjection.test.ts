import { describe, it, expect, vi } from 'vitest';
import { TmuxClient } from './TmuxClient';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';

const srv: ServerConfig = { name: 'local', type: 'local' } as ServerConfig;
const PUBLIC_URL = 'http://100.64.1.42:3001';
const UI_TOKEN = 'test-ui-token-123';

function makeClient(
  execTmux: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>,
  uiToken: string = UI_TOKEN,
): TmuxClient {
  const factory = {
    getTransport: () => ({ execTmux: vi.fn(execTmux) }),
  } as unknown as TransportFactory;
  return new TmuxClient(factory, PUBLIC_URL, uiToken);
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
  it('createSession includes -e AZITO_URL=<publicUrl>', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.createSession(srv, 'test-session', { windowName: 'win' });
    expect(envValue(calls[0], 'AZITO_URL')).toBe(PUBLIC_URL);
  });

  it('createWindow includes -e AZITO_URL=<publicUrl>', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.createWindow(srv, 'test-session', 'win');
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
    expect(envValue(calls[0], 'AZITO_URL')).toBe(PUBLIC_URL);
    expect(envValue(calls[0], 'AZITO_UI_TOKEN')).toBe(UI_TOKEN);
  });

  it('createWindow includes -e AZITO_UI_TOKEN=<uiToken> alongside AZITO_URL', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.createWindow(srv, 'test-session', 'win');
    expect(envValue(calls[0], 'AZITO_URL')).toBe(PUBLIC_URL);
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
