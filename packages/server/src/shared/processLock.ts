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

/**
 * One-at-a-time across processes, by an endpoint only one server can listen on: the lock is held for as long as a `net` server
 * listens on it (a Windows named pipe `\\.\pipe\...`; a unix socket path serves the tests on other OSes). The OS releases it when the
 * holder dies, however it dies, so there is no stale lock to judge or take over and nothing for two takers to race on: `listen` either
 * succeeds (EADDRINUSE otherwise) for exactly one of them. Not queued: when it is held, {@link run} throws {@link ProcessLockBusyError}
 * at once. A holder answers a connection with its process id, which the refusal names.
 */
export class ProcessLock {
  constructor(private readonly endpoint: string, private readonly pid: number = process.pid) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const server = await this.acquire();
    try {
      return await operation();
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  }

  private acquire(): Promise<net.Server> {
    return new Promise<net.Server>((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.on('error', () => undefined); // a probe that went away
        socket.end(String(this.pid));
      });
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EADDRINUSE') {
          reject(err);
          return;
        }
        this.readOwner().then((owner) => reject(new ProcessLockBusyError(this.endpoint, owner)), reject);
      });
      server.listen(this.endpoint, () => {
        server.removeAllListeners('error');
        server.on('error', () => undefined); // after listening, nothing here can fail an operation that already runs
        resolve(server);
      });
    });
  }

  private readOwner(): Promise<number | undefined> {
    return new Promise((resolve) => {
      const socket = net.connect(this.endpoint);
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
 * The lock endpoint of one misao folder: `\\.\pipe\azito-lock-<hash of the folder, lower-cased and normalised>`. The same folder gives the
 * same name whoever asks (the hub, `azito misao ...`, an agent install the hub runs for the same folder), whatever its letter case.
 */
export function misaoRootLockEndpoint(root: string): string {
  const normalised = path.win32.normalize(root).replace(/[\\/]+$/, '').toLowerCase();
  return `\\\\.\\pipe\\azito-lock-${createHash('sha256').update(normalised).digest('hex').slice(0, 16)}`;
}
