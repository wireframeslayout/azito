import { createHash } from 'crypto';
import net from 'net';
import path from 'path';

/** Who holds an endpoint, as the OS says (never as the holder says): this user's process, another user's, or one that could not be told. */
export type HolderVerdict =
  | { state: 'same-user'; pid: number }
  | { state: 'other-user'; pid: number; ownerSid: string }
  | { state: 'unknown'; pid?: number; reason: string };

/** Finds out who holds a taken endpoint. */
export type HolderCheck = (endpoint: string) => Promise<HolderVerdict>;

/** Another process of this user (or another holder in this one) has the lock; `ownerPid` is what the OS says, when a holder check was given. */
export class ProcessLockBusyError extends Error {
  constructor(readonly endpoint: string, readonly ownerPid: number | undefined) {
    super(`${endpoint} is held${ownerPid !== undefined ? ` by process ${ownerPid}` : ' by another process'}`);
    this.name = 'ProcessLockBusyError';
  }
}

/**
 * The endpoint is held by a process that is not this user's, or that could not be identified. That is not "busy, try later": another
 * user can see the name while the lock is held and create the pipe first after it is released, which would keep every later taker
 * out for as long as it likes. The taker stops with this reason instead of waiting on someone it cannot place.
 */
export class ProcessLockForeignHolderError extends Error {
  constructor(readonly endpoint: string, readonly verdict: Exclude<HolderVerdict, { state: 'same-user' }>) {
    super(verdict.state === 'other-user'
      ? `A process of another user (process ${verdict.pid}, owner ${verdict.ownerSid}) holds the lock ${endpoint}: it may have taken the name first`
      : `The process that holds the lock ${endpoint}${verdict.pid !== undefined ? ` (process ${verdict.pid})` : ''} could not be identified as this user's (${verdict.reason})`);
    this.name = 'ProcessLockForeignHolderError';
  }
}

/** How long the holder keeps a connection that was made to it (a holder check connects to ask Windows who serves the pipe): a client that never goes away is cut off, from the moment it connected. */
const CONNECTION_LIFETIME_MS = 2000;

/**
 * One-at-a-time across processes, by an endpoint only one server can listen on: the lock is held for as long as a `net` server
 * listens on it (a Windows named pipe `\\.\pipe\...`; a unix socket path serves the tests on other OSes). The OS releases it when the
 * holder dies, however it dies, so there is no stale lock to judge or take over and nothing for two takers to race on: `listen` either
 * succeeds (EADDRINUSE otherwise) for exactly one of them. Not queued: when it is held, {@link run} throws at once.
 *
 * When it is held and a `holderCheck` is given, the OS is asked who holds it: this user's process is {@link ProcessLockBusyError}
 * (try later); another user's, or one that cannot be identified, is {@link ProcessLockForeignHolderError} (a possible pre-emption).
 * Connections made to the holder live for `CONNECTION_LIFETIME_MS` at most and are all destroyed when the lock is released, so a client
 * that does not go away cannot keep the release waiting.
 *
 * The endpoint is a function when it needs a secret that can fail to be read (see `misaoRootLock.ts`): it is called when the lock is taken.
 */
export class ProcessLock {
  constructor(private readonly endpoint: string | (() => string), private readonly holderCheck?: HolderCheck) {}

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
        const lifetime = setTimeout(() => socket.destroy(), CONNECTION_LIFETIME_MS);
        socket.on('close', () => {
          clearTimeout(lifetime);
          sockets.delete(socket);
        });
        socket.on('error', () => undefined); // a client that went away
      });
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EADDRINUSE') {
          reject(err);
          return;
        }
        this.refusal(endpoint).then(reject, reject);
      });
      server.listen(endpoint, () => {
        server.removeAllListeners('error');
        server.on('error', () => undefined); // after listening, nothing here can fail an operation that already runs
        resolve({ server, sockets });
      });
    });
  }

  private async refusal(endpoint: string): Promise<Error> {
    if (!this.holderCheck) return new ProcessLockBusyError(endpoint, undefined);
    const verdict = await this.holderCheck(endpoint);
    return verdict.state === 'same-user' ? new ProcessLockBusyError(endpoint, verdict.pid) : new ProcessLockForeignHolderError(endpoint, verdict);
  }
}

/**
 * The lock endpoint of one misao folder: `\\.\pipe\azito-lock-<hash of the folder (lower-cased, normalised) and its secret key>`. The same folder and
 * key give the same name whoever asks (the hub, `azito misao ...`, an agent install the hub runs for the same folder), whatever the
 * letter case of the folder; without the key the name cannot be worked out by someone who cannot read the key.
 */
export function misaoRootLockEndpoint(root: string, key: string): string {
  const normalised = path.win32.normalize(root).replace(/[\\/]+$/, '').toLowerCase();
  return `\\\\.\\pipe\\azito-lock-${createHash('sha256').update(`${normalised}\0${key}`).digest('hex').slice(0, 32)}`;
}
