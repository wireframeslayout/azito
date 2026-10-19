import type { WebSocket } from 'ws';
import * as fs from 'fs';
import { FileFollower } from '../../../shared/fs/FileFollower';
import type { ManagedStreamFiles } from './ManagedStreamFiles';

/**
 * `/ws?mode=file-tail`: 管理下（ハブが `POST /api/pane-streams` で登録した）のストリームファイルを、先頭から追跡して送る。
 * 登録されていないパス、存在しないファイル、symlink には何も送らず閉じる。
 */
export function handleFileTail(ws: WebSocket, filePath: string, managed: ManagedStreamFiles): void {
  if (!managed.isManaged(filePath) || !isRegularFile(filePath)) {
    ws.send(JSON.stringify({ error: 'Path not allowed' }));
    ws.close();
    return;
  }

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

  ws.on('close', () => follower.stop());

  try {
    follower.start();
  } catch (err) {
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
