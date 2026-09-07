import { createConnection, type Socket } from 'net';
import { homedir } from 'os';

export interface HerdrResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function herdrSocketPath(sessionName: string): string {
  return `${homedir()}/.config/herdr/sessions/${sessionName}/herdr.sock`;
}

export class HerdrSocketClient {
  private socket: Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private connecting = false;
  private socketPath: string;

  constructor(sessionName: string);
  constructor(socketPath: string, raw: true);
  constructor(arg: string, raw?: true) {
    this.socketPath = raw ? arg : herdrSocketPath(arg);
  }

  async call(method: string, params: unknown = {}): Promise<unknown> {
    const sock = await this.ensureConnected();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + '\n';

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`herdr call "${method}" timed out (15s)`));
      }, 15_000);

      this.pending.set(id, { resolve, reject, timer });
      sock.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.call('ping');
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('HerdrSocketClient closed'));
    }
    this.pending.clear();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.buffer = '';
  }

  private async ensureConnected(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) {
      return new Promise((resolve, reject) => {
        const check = setInterval(() => {
          if (this.socket && !this.socket.destroyed) {
            clearInterval(check);
            resolve(this.socket);
          } else if (!this.connecting) {
            clearInterval(check);
            reject(new Error('Connection failed'));
          }
        }, 50);
      });
    }
    this.connecting = true;
    try {
      this.socket = await this.connect();
      return this.socket;
    } finally {
      this.connecting = false;
    }
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.socketPath);
      const onError = (err: Error) => {
        sock.removeAllListeners();
        reject(new Error(`herdr socket connect failed: ${err.message}`));
      };
      sock.once('error', onError);
      sock.once('connect', () => {
        sock.removeListener('error', onError);
        sock.on('data', (chunk: Buffer) => this.onData(chunk));
        sock.on('close', () => this.onClose());
        sock.on('error', () => this.onClose());
        resolve(sock);
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as HerdrResponse;
        this.dispatch(msg);
      } catch {
        // malformed line — skip
      }
    }
  }

  private dispatch(msg: HerdrResponse): void {
    const req = this.pending.get(msg.id);
    if (!req) return;
    clearTimeout(req.timer);
    this.pending.delete(msg.id);
    if (msg.error) {
      req.reject(new Error(`herdr error ${msg.error.code}: ${msg.error.message}`));
    } else {
      req.resolve(msg.result);
    }
  }

  private onClose(): void {
    this.socket = null;
    this.buffer = '';
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('herdr socket closed'));
    }
    this.pending.clear();
  }
}
