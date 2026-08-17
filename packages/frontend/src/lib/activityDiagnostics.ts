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

/** 判定 Tier を奪わずに状態だけを精緻化した下位 Tier（現状は Tier 0 idle → blocked のみ）。 */
export type ActivityRefinedBy = 'tier2_title';

export interface ActivityDiagnosticRow {
  serverName: string;
  target: string;
  windowId?: number;
  taskId?: number;
  /** 行から該当ウィンドウのタブへ遷移するためのプロジェクト（windows.project_id）。 */
  projectId?: number;
  state: ActivityDecidedState;
  decidedBy: ActivityDecidedBy;
  evidenceAt?: number;
  refinedBy?: ActivityRefinedBy;
  supervisor?: {
    pid: number;
    ready: boolean;
    connectedAt: number;
    lastActivityFrameAt: number | null;
    lastReportedState: 'active' | 'idle' | null;
    lastReportedStatus: 'working' | 'blocked' | null;
    /** Issue #28 Phase C: false = display-only, this connection never drove Tier 0. */
    bound: boolean;
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

/** イベント駆動（supervisor / hook）で判定されている Tier。フォールバック Tier と対になる。 */
export function isEventDrivenTier(decidedBy: ActivityDecidedBy): boolean {
  return decidedBy === 'tier0_supervisor' || decidedBy === 'tier1_hook';
}

/** ステータスバー「稼働検知」アイテムのドット状態。 */
export type ActivityDotState = 'active' | 'inactive' | 'off';

/**
 * 稼働検知ドットの状態。稼働（オフライン以外）が1件も無ければ消灯、イベント駆動（supervisor /
 * hook）で判定している行が1件以上あれば accent、フォールバック Tier だけなら dim。
 * 行がまだ取れていない間（null）は消灯扱いにする — 未取得を「稼働あり」と見せない。
 */
export function activityDotState(rows: ActivityDiagnosticRow[] | null): ActivityDotState {
  const active = rows?.filter((r) => r.state !== 'offline') ?? [];
  if (active.length === 0) return 'off';
  return active.some((r) => isEventDrivenTier(r.decidedBy)) ? 'active' : 'inactive';
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
