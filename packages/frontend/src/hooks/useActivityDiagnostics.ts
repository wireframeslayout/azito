import { useCallback, useEffect, useRef, useState } from 'react';
import { apiWithStatus } from '../api/client';
import { parseDiagnosticsResponse, type ActivityDiagnosticRow } from '../lib/activityDiagnostics';

export type {
  ActivityDecidedBy,
  ActivityDecidedState,
  ActivityDiagnosticRow,
  ActivityStopReason,
} from '../lib/activityDiagnostics';

const POLL_INTERVAL_MS = 3000;

/**
 * 稼働検知診断（GET /api/debug/activity）のライブ取得。読み取り専用の診断エンドポイントなので
 * 単純なポーリングで足りる。タブが非表示の間はポーリングを止め、復帰時に即時再取得する。
 */
export function useActivityDiagnostics(enabled: boolean) {
  const [rows, setRows] = useState<ActivityDiagnosticRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const { status, body } = await apiWithStatus<unknown>('/debug/activity');
      setRows(parseDiagnosticsResponse(status, body));
      setError(null);
    } catch (err) {
      // 直前のスナップショットは残す（1回の取得失敗で表が消えると、まさに診断したい状況で
      // 情報が失われる）。エラーは注記として併記する。初回失敗時は rows が null のままなので、
      // 呼び出し元は「前回スナップショット表示中」ではなく初期エラーとして描画する。
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      void refresh();
      timer = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => { if (document.hidden) stop(); else start(); };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, refresh]);

  return { rows, error, refresh };
}
