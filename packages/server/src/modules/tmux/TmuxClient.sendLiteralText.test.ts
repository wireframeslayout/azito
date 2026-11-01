import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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
  it('rejects escape characters before writing a paste', async () => {
    const handler = vi.fn();
    const client = makeClient(handler);
    await expect(client.pasteTextToHandle(srv, asPaneHandle('%1'), 'x\x1b[201~y')).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
  it('pastes multiline text as one named tmux buffer', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; });
    await client.pasteTextToHandle(srv, asPaneHandle('%1'), 'one\ntwo');
    expect(calls[0]).toEqual(['set-buffer', '-b', expect.any(String), '--', 'one\ntwo']);
    expect(calls[1]).toEqual(['paste-buffer', '-p', '-r', '-d', '-b', calls[0][2], '-t', '%1']);
    expect(calls).toHaveLength(2);
  });

  it('loads a long local paste from a private temporary file and removes it', async () => {
    const calls: string[][] = [];
    const text = 'abc\n'.repeat(200);
    let file = '';
    const client = makeClient(async (args) => {
      calls.push(args);
      if (args[0] === 'load-buffer') { file = args[3]; expect(readFileSync(file, 'utf8')).toBe(text); }
      return { stdout: '', stderr: '', code: 0 };
    });
    await client.pasteTextToHandle(srv, asPaneHandle('%1'), text);
    expect(calls[0][0]).toBe('load-buffer');
    expect(existsSync(file)).toBe(false);
  });

  it('builds a long remote paste in bounded chunks without splitting Unicode', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; });
    const text = '😀\n'.repeat(200);
    await client.pasteTextToHandle({ ...srv, type: 'agent' }, asPaneHandle('%1'), text);
    const chunks = calls.filter((args) => args[0] === 'set-buffer');
    expect(chunks.map((args) => args.at(-1)).join('')).toBe(text);
    expect(chunks.every((args) => Buffer.byteLength(args.at(-1)!, 'utf8') <= 500)).toBe(true);
    expect(chunks.slice(1).every((args) => args.includes('-a'))).toBe(true);
    expect(calls.some((args) => args[0] === 'paste-buffer' && args.includes('-p') && args.includes('-r'))).toBe(true);
  });

  it('escapes a trailing semicolon so tmux does not read it as a command separator', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; });
    await client.pasteTextToHandle(srv, asPaneHandle('%1'), 'one\ntwo;');
    expect(calls[0].at(-1)).toBe('one\ntwo\\;');
  });

  it('escapes a trailing semicolon at every remote chunk boundary', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; });
    const text = `${'a'.repeat(99)};\n`.repeat(6);
    await client.pasteTextToHandle({ ...srv, type: 'agent' }, asPaneHandle('%1'), text);
    const chunks = calls.filter((args) => args[0] === 'set-buffer').map((args) => args.at(-1)!);
    expect(chunks[0]).toBe(`${'a'.repeat(99)}\\;`);
    expect(chunks.map((c) => (c.endsWith('\\;') ? `${c.slice(0, -2)};` : c)).join('')).toBe(text);
  });

  it('cleans up a named buffer and never pastes after a failed load', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: args[0] === 'load-buffer' ? 1 : 0 };
    });
    await expect(client.pasteTextToHandle(srv, asPaneHandle('%1'), 'a'.repeat(501))).rejects.toThrow('Unable to prepare chat paste');
    expect(calls.some((args) => args[0] === 'paste-buffer')).toBe(false);
    expect(calls.at(-1)?.[0]).toBe('delete-buffer');
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

  it.each([
    ['foo;', 'foo\\;'],
    ['a; b', 'a; b'],
    ['\\;', '\\\\;'],
  ])('preserves literal text %s in the tmux argument', async (text, expected) => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; });
    await client.sendTextToHandle(srv, asPaneHandle('%1'), text);
    expect(calls).toEqual([['send-keys', '-t', '%1', '-l', expected]]);
  });

  it('escapes semicolons at remote long-text chunk boundaries', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; });
    const text = `${'a'.repeat(98)}\\;${'b'.repeat(99)};${'c'.repeat(301)}`;
    await client.sendTextToHandle({ ...srv, type: 'agent' }, asPaneHandle('%1'), text);
    expect(calls.map((args) => args.at(-1))).toEqual([
      `${'a'.repeat(98)}\\\\;`, `${'b'.repeat(99)}\\;`, 'c'.repeat(100), 'c'.repeat(100), 'c'.repeat(100), 'c',
    ]);
  });

  it('keeps surrogate pairs intact at remote chunk boundaries and bounds argument size', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; });
    const text = `${'a'.repeat(99)}${'😀'.repeat(120)};`;
    await client.sendTextToHandle({ ...srv, type: 'agent' }, asPaneHandle('%1'), text);
    const chunks = calls.map((args) => args.at(-1)!);
    expect(chunks[0]).toBe(`${'a'.repeat(99)}😀`);
    expect(chunks.map((chunk) => chunk.endsWith('\\;') ? `${chunk.slice(0, -2)};` : chunk).join('')).toBe(text);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 500)).toBe(true);
  });

  it('reports a failed Enter command', async () => {
    const client = makeClient(async () => ({ stdout: '', stderr: 'failed', code: 1 }));
    await expect(client.sendKeysToHandle(srv, asPaneHandle('%1'), ['Enter'])).rejects.toThrow('Unable to send key');
  });

  it('escapes a trailing semicolon in short literal keys', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; });
    await client.sendKeysToHandle(srv, asPaneHandle('%1'), ['foo;', 'Enter']);
    expect(calls).toEqual([['send-keys', '-t', '%1', '-l', 'foo\\;'], ['send-keys', '-t', '%1', 'Enter']]);
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
