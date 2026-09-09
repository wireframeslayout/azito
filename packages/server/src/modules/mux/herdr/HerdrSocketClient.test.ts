import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HerdrSocketClient } from './HerdrSocketClient';

function createMockServer(handler: (req: Record<string, unknown>) => Record<string, unknown>): { server: Server; socketPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-test-'));
  const socketPath = join(dir, 'herdr.sock');
  const server = createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const req = JSON.parse(line);
      const result = handler(req);
      conn.end(JSON.stringify(result) + '\n');
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

  function setup(handler: (req: Record<string, unknown>) => Record<string, unknown>) {
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
      if (req.method === 'ping') return { type: 'pong', version: '0.8.2', protocol: 20 };
      return { type: 'ok' };
    });
    const result = await client.call('ping');
    expect(result.type).toBe('pong');
    expect(result.version).toBe('0.8.2');
  });

  it('ping returns true for pong response', async () => {
    const client = setup(() => ({ type: 'pong', version: '0.8.2', protocol: 20, capabilities: {} }));
    expect(await client.ping()).toBe(true);
  });

  it('handles multiple sequential requests (each gets its own connection)', async () => {
    let callCount = 0;
    const client = setup((req) => {
      callCount++;
      return { type: 'ok', echo: req.method, call: callCount };
    });
    const r1 = await client.call('a');
    const r2 = await client.call('b');
    const r3 = await client.call('c');
    expect(r1.echo).toBe('a');
    expect(r2.echo).toBe('b');
    expect(r3.echo).toBe('c');
    expect(callCount).toBe(3);
  });

  it('rejects on herdr error response', async () => {
    const client = setup(() => ({ id: '1', error: { code: 'not_found', message: 'pane not found' } }));
    await expect(client.call('bad')).rejects.toThrow('herdr error not_found: pane not found');
  });

  it('handles params correctly', async () => {
    let receivedParams: unknown;
    const client = setup((req) => {
      receivedParams = req.params;
      return { type: 'ok' };
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
        const idx = buf.indexOf('\n');
        if (idx === -1) return;
        const resp = JSON.stringify({ type: 'ok', value: 'split-ok' }) + '\n';
        conn.write(resp.slice(0, 5));
        setTimeout(() => conn.end(resp.slice(5)), 10);
      });
    });
    server.listen(socketPath);
    const client = new HerdrSocketClient(socketPath, true);
    cleanup.push(() => { client.close(); server.close(); try { rmSync(socketPath); } catch {} });

    const result = await client.call('split');
    expect(result.value).toBe('split-ok');
  });

  it('rejects when socket is not reachable', async () => {
    const client = new HerdrSocketClient('/tmp/nonexistent-herdr-test.sock', true);
    cleanup.push(() => client.close());
    await expect(client.call('ping')).rejects.toThrow();
  });
});
