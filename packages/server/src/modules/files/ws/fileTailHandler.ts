import type { WebSocket } from 'ws';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';

const ALLOWED_PREFIX = '/tmp/azito-pipe-';

export function handleFileTail(ws: WebSocket, filePath: string): void {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ALLOWED_PREFIX)) {
    ws.send(JSON.stringify({ error: 'Path not allowed' }));
    ws.close();
    return;
  }

  let tailProc: ChildProcess | null = null;

  tailProc = spawn('tail', ['-f', '-n', '+1', resolved], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  tailProc.stdout!.on('data', (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk.toString('utf-8'));
  });

  tailProc.on('error', (err) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ error: err.message }));
      ws.close();
    }
  });

  tailProc.on('exit', () => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on('close', () => {
    if (tailProc) {
      tailProc.kill('SIGTERM');
      tailProc = null;
    }
  });
}
