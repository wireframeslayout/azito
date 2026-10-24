import { describe, it, expect, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { AgentProtocol, Client, Server, utils, type ParsedKey } from 'ssh2';
import { SshClient } from './SshClient';

/**
 * Authentication through an ssh-agent, with the real ssh2 client on one side and an agent speaking the OpenSSH agent protocol
 * on the other, over a Unix socket (Linux / macOS) or a named pipe (Windows, where the OpenSSH agent service listens on one).
 * No key file is given to the client, so the only way in is the agent.
 */

function agentAddress(): string {
  const id = crypto.randomBytes(6).toString('hex');
  return process.platform === 'win32' ? `\\\\.\\pipe\\azito-test-agent-${id}` : path.join(os.tmpdir(), `azito-agent-${id}.sock`);
}

async function listen(server: net.Server, address: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });
}

function startAgent(address: string, key: ParsedKey): net.Server {
  return net.createServer((socket) => {
    const protocol = new AgentProtocol(false);
    protocol.on('identities', (req) => protocol.getIdentitiesReply(req, [key]));
    protocol.on('sign', (req, _pubKey, data) => protocol.signReply(req, key.sign(data)));
    protocol.pipe(socket).pipe(protocol);
    socket.on('error', () => {});
  });
}

describe('SshClient authenticating through an ssh-agent', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function closeServer(server: net.Server | Server): () => Promise<void> {
    return () => new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async function startSshServer(acceptedKey: ParsedKey): Promise<number> {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const server = new Server({ hostKeys: [hostKey.private] }, (conn) => {
      conn.on('authentication', (ctx) => {
        if (ctx.method === 'publickey' && ctx.username === 'alice' && ctx.key.algo === acceptedKey.type && ctx.key.data.equals(acceptedKey.getPublicSSH())) {
          if (ctx.signature && ctx.blob) {
            return acceptedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject();
          }
          return ctx.accept();
        }
        return ctx.reject(['publickey']);
      });
      conn.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(closeServer(server));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('unexpected server address');
    return address.port;
  }

  async function connectWith(authSock: string | undefined, port: number): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-agent-home-'));
    cleanups.push(async () => fs.rmSync(home, { recursive: true, force: true }));
    const client = new SshClient({ homeDir: home, platform: process.platform, authSock, defaultUser: 'alice' });
    const opts = client.buildConnectOpts(client.resolveHost(`alice@127.0.0.1:${port}`));
    const conn = new Client();
    try {
      await new Promise<void>((resolve, reject) => {
        conn.on('ready', () => resolve());
        conn.on('error', reject);
        conn.connect(opts);
      });
    } finally {
      conn.end();
    }
  }

  it('signs with the key the agent holds (no key file anywhere)', async () => {
    const userKey = utils.generateKeyPairSync('ed25519');
    const parsed = utils.parseKey(userKey.private);
    if (parsed instanceof Error) throw parsed;
    const address = agentAddress();
    const agent = startAgent(address, parsed);
    await listen(agent, address);
    cleanups.push(closeServer(agent));
    const port = await startSshServer(parsed);

    await expect(connectWith(address, port)).resolves.toBeUndefined();
  });

  it('is refused when the agent holds a different key', async () => {
    const accepted = utils.parseKey(utils.generateKeyPairSync('ed25519').private);
    const other = utils.parseKey(utils.generateKeyPairSync('ed25519').private);
    if (accepted instanceof Error || other instanceof Error) throw new Error('key generation failed');
    const address = agentAddress();
    const agent = startAgent(address, other);
    await listen(agent, address);
    cleanups.push(closeServer(agent));
    const port = await startSshServer(accepted);

    await expect(connectWith(address, port)).rejects.toThrow(/All configured authentication methods failed/);
  });

  it('is refused, with no crash, when there is no agent at all', async () => {
    const accepted = utils.parseKey(utils.generateKeyPairSync('ed25519').private);
    if (accepted instanceof Error) throw accepted;
    const port = await startSshServer(accepted);

    await expect(connectWith(undefined, port)).rejects.toThrow(/All configured authentication methods failed/);
  });
});

describe.skipIf(process.platform !== 'win32')('a Windows named pipe as seen by the file system', () => {
  it('exists while a server listens on it and not after it closes (what resolveSshAgent relies on)', async () => {
    const pipe = agentAddress();
    const server = net.createServer();
    await listen(server, pipe);
    expect(fs.existsSync(pipe)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(fs.existsSync(pipe)).toBe(false);
  });
});
