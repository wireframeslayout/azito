import { createHash } from 'crypto';
import net from 'net';
import path from 'path';

/** Another process (or another holder in this one) has the lock. */
export class ProcessLockBusyError extends Error {
  constructor(readonly endpoint: string, readonly ownerPid: number | undefined) {
    super(`${endpoint} is held${ownerPid !== undefined ? ` by process ${ownerPid}` : ' by another process'}`);
    this.name = 'ProcessLockBusyError';
  }
}

/** How long a refused taker waits to hear who holds the lock (only to name it in the refusal). */
const OWNER_PROBE_MS = 1000;
/** How long the holder keeps a connection that asked who it is: a client that never reads is cut off, never waited for. */
const ANSWER_LIMIT_MS = 2000;

/**
 * One-at-a-time across processes, by an endpoint only one server can listen on: the lock is held for as long as a `net` server
 * listens on it (a Windows named pipe `\\.\pipe\...`; a unix socket path serves the tests on other OSes). The OS releases it when the
 * holder dies, however it dies, so there is no stale lock to judge or take over and nothing for two takers to race on: `listen` either
 * succeeds (EADDRINUSE otherwise) for exactly one of them. Not queued: when it is held, {@link run} throws {@link ProcessLockBusyError}
 * at once. A holder answers a connection with its process id, which the refusal names; those connections are cut after `ANSWER_LIMIT_MS`
 * and all of them are destroyed when the lock is released, so a client that does not read cannot keep the release waiting.
 *
 * The endpoint is a function when it needs a secret that can fail to be read (see `misaoRootLock.ts`): it is called when the lock is taken.
 */
export class ProcessLock {
  constructor(private readonly endpoint: string | (() => string), private readonly pid: number = process.pid) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const held = await this.acquire(typeof this.endpoint === 'string' ? this.endpoint : this.endpoint());
    try {
      return await operation();
    } finally {
      for (const socket of held.sockets) socket.destroy();
      await new Promise<void>((resolve) => { held.server.close(() => resolve()); });
    }
  }

  private acquire(endpoint: string): Promise<{ server: net.Server; sockets: Set<net.Socket> }> {
    return new Promise((resolve, reject) => {
      const sockets = new Set<net.Socket>();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => undefined); // a probe that went away
        socket.setTimeout(ANSWER_LIMIT_MS, () => socket.destroy());
        socket.end(String(this.pid));
      });
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EADDRINUSE') {
          reject(err);
          return;
        }
        this.readOwner(endpoint).then((owner) => reject(new ProcessLockBusyError(endpoint, owner)), reject);
      });
      server.listen(endpoint, () => {
        server.removeAllListeners('error');
        server.on('error', () => undefined); // after listening, nothing here can fail an operation that already runs
        resolve({ server, sockets });
      });
    });
  }

  private readOwner(endpoint: string): Promise<number | undefined> {
    return new Promise((resolve) => {
      const socket = net.connect(endpoint);
      let text = '';
      const done = (): void => {
        socket.destroy();
        clearTimeout(timer);
        resolve(/^\d+$/.test(text) ? Number(text) : undefined);
      };
      const timer = setTimeout(done, OWNER_PROBE_MS);
      socket.on('data', (chunk) => { text += chunk.toString('utf-8'); });
      socket.on('end', done);
      socket.on('error', done);
    });
  }
}

/**
 * The lock endpoint of one misao folder: `\\.\pipe\azito-lock-<hash of the folder (lower-cased, normalised) and its secret key>`. The same folder and
 * key give the same name whoever asks (the hub, `azito misao ...`, an agent install the hub runs for the same folder), whatever the
 * letter case of the folder; without the key the name cannot be worked out, so another user cannot create the pipe first.
 */
export function misaoRootLockEndpoint(root: string, key: string): string {
  const normalised = path.win32.normalize(root).replace(/[\\/]+$/, '').toLowerCase();
  return `\\\\.\\pipe\\azito-lock-${createHash('sha256').update(`${normalised}\0${key}`).digest('hex').slice(0, 32)}`;
}
