import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import { createMisaoRelay } from './misaoRelay';
import { MISAO_RELAY_CLOSE, readMisaoSocketStatus, resolveAgentMisaoSocket } from '../modules/servers/transport/agentMisaoSocket';

describe('resolveAgentMisaoSocket', () => {
  it('defaults to the managed socket under the home directory', () => {
    expect(resolveAgentMisaoSocket({}, '/home/u').path).toBe('/home/u/.azito/misao/misao.sock');
  });

  it('uses MISAO_SOCKET when it is set', () => {
    expect(resolveAgentMisaoSocket({ MISAO_SOCKET: '/run/misao.sock' }, '/home/u').path).toBe('/run/misao.sock');
  });

  it('treats an empty MISAO_SOCKET as unset', () => {
    expect(resolveAgentMisaoSocket({ MISAO_SOCKET: '' }, '/home/u').path).toBe('/home/u/.azito/misao/misao.sock');
  });

  it('rejects a relative path and a path over the unix socket limit', () => {
    expect(() => resolveAgentMisaoSocket({ MISAO_SOCKET: 'misao.sock' }, '/home/u')).toThrow(/absolute/);
    expect(() => resolveAgentMisaoSocket({ MISAO_SOCKET: `/${'a'.repeat(120)}` }, '/home/u')).toThrow(/limit/);
  });
});

describe('relay to a unix socket', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azrelay-'));
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  async function startRelay(socketPath: string | null): Promise<string> {
    const relay = createMisaoRelay(socketPath ? { path: socketPath } : null, { warn: () => undefined });
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws) => relay(ws));
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    cleanups.push(() => new Promise<void>((resolve) => { for (const c of wss.clients) c.terminate(); wss.close(() => resolve()); }));
    return `ws://127.0.0.1:${(wss.address() as net.AddressInfo).port}`;
  }

  function closeInfo(ws: WebSocket): Promise<{ code: number }> {
    return new Promise((resolve) => ws.once('close', (code) => resolve({ code })));
  }

  it('carries bytes both ways to the fixed socket', async () => {
    const dir = tmpDir();
    const socketPath = path.join(dir, 'm.sock');
    const server = net.createServer((conn) => conn.on('data', (chunk) => conn.write(Buffer.concat([Buffer.from('echo:'), chunk]))));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const url = await startRelay(socketPath);
    const ws = new WebSocket(url);
    const received = new Promise<string>((resolve) => ws.once('message', (data: Buffer) => resolve(data.toString())));
    await new Promise<void>((resolve) => ws.once('open', resolve));
    ws.send('hello');
    expect(await received).toBe('echo:hello');
    ws.close();
  });

  it('closes with daemonUnreachable when nothing listens on the socket', async () => {
    const url = await startRelay(path.join(tmpDir(), 'none.sock'));
    const ws = new WebSocket(url);
    expect((await closeInfo(ws)).code).toBe(MISAO_RELAY_CLOSE.daemonUnreachable);
  });

  it('closes with disabled when no socket is configured', async () => {
    const url = await startRelay(null);
    const ws = new WebSocket(url);
    expect((await closeInfo(ws)).code).toBe(MISAO_RELAY_CLOSE.disabled);
  });
});

const HOST = { homeDir: '/nonexistent-home', nodePath: '/usr/bin/node', servicePath: '/usr/bin', nodePtyDir: null, platform: 'linux' as const, arch: 'x64' };

describe('readMisaoSocketStatus', () => {
  it('reports an absent socket', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azrelay-'));
    try {
      expect(readMisaoSocketStatus({ path: path.join(dir, 'x.sock') }, HOST)).toEqual({ socketPath: path.join(dir, 'x.sock'), socketPresent: false, host: HOST });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a socket and the version current points at under the home directory\'s managed layout', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'azrelay-'));
    const dir = path.join(home, '.azito', 'misao');
    fs.mkdirSync(dir, { recursive: true });
    const socketPath = path.join(dir, 'x.sock');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    fs.symlinkSync('0.2.0', path.join(dir, 'current'));
    const host = { ...HOST, homeDir: home };
    try {
      expect(readMisaoSocketStatus({ path: socketPath }, host)).toEqual({ socketPath, socketPresent: true, installedVersion: '0.2.0', host });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
