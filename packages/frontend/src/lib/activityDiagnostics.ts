// 稼働検知診断（GET /api/debug/activity）のレスポンス型と、その検証（純ロジック）。
// 検証をフックから切り離してあるのは、非2xx や想定外ボディの扱いが描画に依存せず単体で
// テストできるようにするため。

export type ActivityDecidedBy =
  | 'tier0_supervisor'
  | 'tier1_hook'
  | 'tier2_title'
  | 'tier3_heuristic'
  | 'tier4_probe'
  | 'none';

export type ActivityDecidedState = 'working' | 'blocked' | 'idle' | 'offline' | 'none';

export type ActivityStopReason = 'completed' | 'interrupted' | 'deleted' | 'offline' | 'unknown';

export interface ActivityDiagnosticRow {
  serverName: string;
  target: string;
  windowId?: number;
  taskId?: number;
  state: ActivityDecidedState;
  decidedBy: ActivityDecidedBy;
  evidenceAt?: number;
  supervisor?: {
    pid: number;
    ready: boolean;
    connectedAt: number;
    lastActivityFrameAt: number | null;
    lastReportedState: 'active' | 'idle' | null;
    lastReportedStatus: 'working' | 'blocked' | null;
  };
  hook?: { lastSignalAt: number; lastEvent: 'start' | 'stop' };
  probe?: {
    status: 'working' | 'idle' | 'offline';
    tailState?: string;
    lastEntryTimestampMs?: number | null;
    completedAt: number | null;
    interruptedAt: number | null;
    snapshotAgeMs: number | null;
  };
  lastTransition?: { running: boolean; reason?: ActivityStopReason; at: number };
}

/**
 * HTTP ステータスとボディを診断行の配列として受け入れる。api() は 401 以外の非2xx を reject
 * しないため、500 のエラーオブジェクトがそのまま行配列として流れて描画時に落ちる。ここで
 * 境界として弾き、呼び出し元は例外だけを扱えばよいようにする。
 */
export function parseDiagnosticsResponse(status: number, body: unknown): ActivityDiagnosticRow[] {
  if (status < 200 || status >= 300) {
    throw new Error(`GET /api/debug/activity failed with status ${status}`);
  }
  if (!Array.isArray(body)) {
    throw new Error('GET /api/debug/activity returned an unexpected body');
  }
  return body as ActivityDiagnosticRow[];
}
