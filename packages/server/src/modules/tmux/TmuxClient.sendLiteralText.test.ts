import { describe, it, expect, vi } from 'vitest';
import { asPaneHandle } from '@azito/shared';
import { TmuxClient } from './TmuxClient';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';

const srv: ServerConfig = { name: 'local', type: 'local' } as ServerConfig;

function makeClient(handler: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>): TmuxClient {
  const execMux = vi.fn((req: { kind: string; args: string[] }) => handler(req.args));
  const factory = {
    getTransport: () => ({ execMux }),
  } as unknown as TransportFactory;
  return new TmuxClient(factory, 'http://localhost:3001', '', 'http://127.0.0.1:3001', 'wh-tok', '');
}

describe('TmuxClient.sendLiteralText', () => {
  it('pastes multiline text as one named tmux buffer', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; });
    await client.pasteTextToHandle(srv, asPaneHandle('%1'), 'one\ntwo');
    expect(calls[0]).toEqual(['set-buffer', '-b', expect.any(String), '--', 'one\ntwo']);
    expect(calls[1]).toEqual(['paste-buffer', '-p', '-r', '-d', '-b', calls[0][2], '-t', '%1']);
  });

  it('sends short text via send-keys -l, never as a special-key match', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.sendLiteralText(srv, '%1', 'C-c');
    expect(calls).toEqual([['send-keys', '-t', '%1', '-l', 'C-c']]);
  });

  it('sends other special-key-looking text (Enter, Escape) via the literal path too', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.sendLiteralText(srv, '%1', 'Enter');
    await client.sendLiteralText(srv, '%1', 'Escape');
    expect(calls).toEqual([
      ['send-keys', '-t', '%1', '-l', 'Enter'],
      ['send-keys', '-t', '%1', '-l', 'Escape'],
    ]);
  });

  it('routes text over 500 bytes through the long-text (buffer) path instead of send-keys -l', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    const longText = 'x'.repeat(600);
    await client.sendLiteralText(srv, '%1', longText);
    expect(calls.some((c) => c[0] === 'load-buffer' || c[0] === 'paste-buffer')).toBe(true);
    expect(calls.some((c) => c[0] === 'send-keys' && c.includes('-l') && c.includes(longText))).toBe(false);
  });
});
