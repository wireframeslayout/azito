import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HerdrSocketClient } from './HerdrSocketClient';

function createMockServer(handler: (req: { id: number; method: string; params: unknown }) => unknown): { server: Server; socketPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-test-'));
  const socketPath = join(dir, 'herdr.sock');
  const server = createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        const result = handler(req);
        if (result instanceof Error) {
          conn.write(JSON.stringify({ id: req.id, error: { code: -1, message: result.message } }) + '\n');
        } else {
          conn.write(JSON.stringify({ id: req.id, result }) + '\n');
        }
      }
    });
  });
  server.listen(socketPath);
  return { server, socketPath };
}

describe('HerdrSocketClient', () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup.length = 0;
  });

  function setup(handler: (req: { id: number; method: string; params: unknown }) => unknown) {
    const { server, socketPath } = createMockServer(handler);
    const client = new HerdrSocketClient(socketPath, true);
    cleanup.push(() => {
      client.close();
      server.close();
      try { rmSync(socketPath); } catch { /* ignore */ }
    });
    return client;
  }

  it('sends request and receives response', async () => {
    const client = setup((req) => {
      if (req.method === 'ping') return { pong: true };
      return null;
    });
    const result = await client.call('ping');
    expect(result).toEqual({ pong: true });
  });

  it('ping returns true on success', async () => {
    const client = setup(() => 'pong');
    expect(await client.ping()).toBe(true);
  });

  it('correlates multiple concurrent requests', async () => {
    const client = setup((req) => ({ echo: req.method }));
    const [r1, r2, r3] = await Promise.all([
      client.call('a'),
      client.call('b'),
      client.call('c'),
    ]);
    expect(r1).toEqual({ echo: 'a' });
    expect(r2).toEqual({ echo: 'b' });
    expect(r3).toEqual({ echo: 'c' });
  });

  it('rejects on herdr error response', async () => {
    const client = setup(() => new Error('not found'));
    await expect(client.call('bad')).rejects.toThrow('herdr error -1: not found');
  });

  it('rejects on socket close', async () => {
    const { server, socketPath } = createMockServer(() => null);
    const client = new HerdrSocketClient(socketPath, true);
    cleanup.push(() => { client.close(); server.close(); });

    server.close();
    // Wait for server to close
    await new Promise((r) => setTimeout(r, 50));
    await expect(client.call('ping')).rejects.toThrow();
  });

  it('handles params correctly', async () => {
    let receivedParams: unknown;
    const client = setup((req) => {
      receivedParams = req.params;
      return 'ok';
    });
    await client.call('test', { foo: 'bar', n: 42 });
    expect(receivedParams).toEqual({ foo: 'bar', n: 42 });
  });

  it('handles responses split across chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-split-'));
    const socketPath = join(dir, 'herdr.sock');
    const server = createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const req = JSON.parse(line);
          const resp = JSON.stringify({ id: req.id, result: 'split-ok' }) + '\n';
          // Send in two parts
          conn.write(resp.slice(0, 5));
          setTimeout(() => conn.write(resp.slice(5)), 10);
        }
      });
    });
    server.listen(socketPath);
    const client = new HerdrSocketClient(socketPath, true);
    cleanup.push(() => { client.close(); server.close(); try { rmSync(socketPath); } catch {} });

    const result = await client.call('split');
    expect(result).toBe('split-ok');
  });
});
