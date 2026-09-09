import { createConnection, type Socket } from 'net';
import { homedir } from 'os';

export interface HerdrResponse {
  type?: string;
  id?: string;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

export function herdrSocketPath(sessionName: string): string {
  return `${homedir()}/.config/herdr/sessions/${sessionName}/herdr.sock`;
}

/**
 * herdr NDJSON socket client. herdr uses **one connection per request**: the
 * server sends one JSON response line then closes the connection. Each `call()`
 * opens a fresh Unix socket, sends the request, reads the response, and closes.
 */
export class HerdrSocketClient {
  private nextId = 1;
  readonly socketPath: string;
  readonly sessionName: string;

  constructor(sessionName: string);
  constructor(socketPath: string, raw: true);
  constructor(arg: string, raw?: true) {
    this.socketPath = raw ? arg : herdrSocketPath(arg);
    this.sessionName = raw ? '' : arg;
  }

  async call(method: string, params: unknown = {}): Promise<HerdrResponse> {
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, method, params }) + '\n';

    return new Promise<HerdrResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`herdr call "${method}" timed out (15s)`));
      }, 15_000);

      let buffer = '';
      const sock = createConnection(this.socketPath);

      sock.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`herdr socket error: ${err.message}`));
      });

      sock.once('connect', () => {
        sock.write(payload, (err) => {
          if (err) {
            clearTimeout(timer);
            reject(err);
          }
        });
      });

      sock.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const idx = buffer.indexOf('\n');
        if (idx === -1) return;
        const line = buffer.slice(0, idx);
        clearTimeout(timer);
        sock.destroy();
        try {
          const msg = JSON.parse(line) as HerdrResponse;
          if (msg.error) {
            reject(new Error(`herdr error ${msg.error.code}: ${msg.error.message}`));
          } else {
            resolve(msg);
          }
        } catch (e) {
          reject(new Error(`herdr: malformed response: ${line.slice(0, 200)}`));
        }
      });

      sock.once('close', () => {
        clearTimeout(timer);
        if (buffer.trim()) {
          try {
            const msg = JSON.parse(buffer.trim()) as HerdrResponse;
            if (msg.error) {
              reject(new Error(`herdr error ${msg.error.code}: ${msg.error.message}`));
            } else {
              resolve(msg);
            }
            return;
          } catch { /* fall through */ }
        }
      });
    });
  }

  async callRpc(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
    const raw = await this.call(method, params);
    if (raw && typeof raw === 'object' && 'result' in raw && !('type' in raw)) {
      return (raw.result ?? {}) as Record<string, unknown>;
    }
    return raw as Record<string, unknown>;
  }

  async ping(): Promise<boolean> {
    try {
      const resp = await this.call('ping');
      return resp.type === 'pong';
    } catch {
      return false;
    }
  }

  close(): void {
    // no-op: each call uses its own connection
  }

  openStream(): Socket {
    return createConnection(this.socketPath);
  }
}
