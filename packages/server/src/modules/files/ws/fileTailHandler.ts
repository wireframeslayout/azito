import type { WebSocket } from 'ws';
import * as fs from 'fs';
import { FileFollower } from '../../../shared/fs/FileFollower';
import type { ManagedStreamFiles } from './ManagedStreamFiles';

/**
 * `/ws?mode=file-tail`: 管理下（ハブが `POST /api/pane-streams` で登録した）のストリームファイルを、先頭から追跡して送る。
 * 登録されていないパス、存在しないファイル、symlink には何も送らず閉じる。
 */
export const FILE_TAIL_PING_INTERVAL_MS = 30_000;

export function handleFileTail(ws: WebSocket, filePath: string, managed: ManagedStreamFiles, pingIntervalMs: number = FILE_TAIL_PING_INTERVAL_MS): void {
  if (!managed.isManaged(filePath) || !isRegularFile(filePath)) {
    ws.send(JSON.stringify({ error: 'Path not allowed' }));
    ws.close();
    return;
  }

  const detach = managed.attach(filePath);
  const follower = new FileFollower(filePath, {
    onData: (text) => {
      if (ws.readyState === ws.OPEN) ws.send(text);
    },
    onError: (err) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ error: err.message }));
        ws.close();
      }
    },
  });

  // A half-open connection (the hub vanished without closing) would hold the registration's lease for good: ping, and drop it
  // when a whole interval passes without a pong.
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const pinger = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, pingIntervalMs);

  ws.on('close', () => {
    clearInterval(pinger);
    follower.stop();
    detach();
  });

  try {
    follower.start();
  } catch (err) {
    clearInterval(pinger);
    detach();
    ws.send(JSON.stringify({ error: (err as Error).message }));
    ws.close();
  }
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}
