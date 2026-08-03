import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Server, ServerStatus } from './useServerManagement';

// 画面を開き直すたびに「確認中/切断」から始まらないよう、最後に取得した
// サーバー一覧・接続状態を sessionStorage に保持し、Provider マウント時の初期値に使う
// （フルリロード直後の初期表示用）。再取得はバックグラウンドで走り、完了時に差分だけが反映される。
const STATUS_CACHE_KEY = 'server-status-cache-v1';
const POLL_INTERVAL_MS = 30000;

function loadStatusCache(): { servers: Server[]; statuses: Record<string, ServerStatus> } {
  try {
    const raw = sessionStorage.getItem(STATUS_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.servers) && parsed.statuses && typeof parsed.statuses === 'object') {
        return { servers: parsed.servers, statuses: parsed.statuses };
      }
    }
  } catch { /* 破損時は空から */ }
  return { servers: [], statuses: {} };
}

function persistStatusCache(servers: Server[], statuses: Record<string, ServerStatus>): void {
  try {
    sessionStorage.setItem(STATUS_CACHE_KEY, JSON.stringify({ servers, statuses }));
  } catch { /* quota等は無視 */ }
}

interface ServerStatusContextValue {
  servers: Server[];
  statuses: Record<string, ServerStatus>;
  refresh: () => Promise<Server[]>;
}

const ServerStatusContext = createContext<ServerStatusContextValue | null>(null);

export function ServerStatusProvider({ children }: { children: React.ReactNode }) {
  const initialCache = useRef(loadStatusCache());
  const [servers, setServers] = useState<Server[]>(initialCache.current.servers);
  const [statuses, setStatuses] = useState<Record<string, ServerStatus>>(initialCache.current.statuses);

  // リクエスト識別用: refresh() 呼び出しごとに増分する（成否に関わらず）。
  const requestSeqRef = useRef(0);
  // 「最新の有効世代」: /servers が成功した時点でのみ進める。失敗したリクエストは
  // 進行中の成功していた旧リクエストから active を奪わない（部分障害での一覧固まりを防ぐ）。
  const activeSeqRef = useRef(0);
  // 世代が勝って setServers された最新の確定済み一覧。stale な refresh() 呼び出し元が
  // 古い srvs を return して存在検証・セッション取得を誤らせないよう、勝った世代が
  // 同期的にここを更新する（refresh() の return 値の基準として使う）。
  const serversRef = useRef<Server[]>(initialCache.current.servers);
  // サーバー設定ごとの in-flight プローブ。SSH 等の遅いプローブ（〜30s）が前の 30s ポーリングの
  // 世代前進で恒久的に破棄され checking のまま固まる問題を防ぐため、同じサーバー設定のプローブが
  // in-flight の間は新たに発行しない。キーはサーバー名だけでなく設定のフィンガープリントにし、
  // プローブ中に host/type/agentPort が編集される（または同名で削除→再作成される）場合に
  // 旧設定の結果が新設定のサーバーへ誤帰属しないようにする。
  const probeInFlightRef = useRef<Map<string, Promise<void>>>(new Map());

  const getServerFingerprint = (srv: Server): string =>
    `${srv.name}|${srv.type}|${srv.host ?? ''}|${srv.agentPort ?? ''}|${srv.sshHost ?? ''}|${srv.muxRuntime ?? ''}|${srv.hasAgentToken ? '1' : '0'}`;

  // 各サーバーのステータス探査（重い・遅いサーバーが混ざりうる）は fire-and-forget の
  // バックグラウンドで実行し、refresh() 自体の resolve を待たせない。
  // allSettled でまとめて反映せず、解決したサーバーから1件ずつ反映することで、
  // 遅いサーバー1台が速いサーバーの表示更新を道連れにしないようにする。
  const probeStatuses = useCallback((srvs: Server[]): void => {
    for (const srv of srvs) {
      const fingerprint = getServerFingerprint(srv);
      if (probeInFlightRef.current.has(fingerprint)) continue;

      // 結果到着時、同一フィンガープリント（name+type+host+agentPort）のサーバーが
      // 最新の確定済み servers 一覧にまだ存在していれば反映する（世代番号ではなく設定の
      // 存在で判定するため、遅く返ってきた結果も無条件に捨てないが、設定変更後の結果は帰属させない）
      const promise = api<ServerStatus>(`/servers/${encodeURIComponent(srv.name)}/status`)
        .then((status) => {
          if (serversRef.current.some((s) => getServerFingerprint(s) === fingerprint)) {
            setStatuses((prev) => ({ ...prev, [srv.name]: status }));
          }
        })
        .catch((err) => {
          if (serversRef.current.some((s) => getServerFingerprint(s) === fingerprint)) {
            console.warn('[useServerStatuses] status probe failed:', srv.name, err);
            setStatuses((prev) => ({
              ...prev,
              [srv.name]: { status: 'error', tmux: false, message: 'Failed to check status' },
            }));
          }
        })
        .finally(() => {
          probeInFlightRef.current.delete(fingerprint);
        });

      probeInFlightRef.current.set(fingerprint, promise);
    }
  }, []);

  const refresh = useCallback(async (): Promise<Server[]> => {
    const seq = ++requestSeqRef.current;

    const srvs: Server[] = await api('/servers');

    // /servers 成功時点でこのリクエストを最新有効世代として確定する
    activeSeqRef.current = Math.max(activeSeqRef.current, seq);
    if (seq !== activeSeqRef.current) return serversRef.current;

    serversRef.current = srvs;
    setServers(srvs);

    // 既知のステータスがあるサーバーはそのまま維持し、未取得のサーバーのみ checking にする
    // （再チェックのたびに全体をグレー化してフリッカーさせないため）
    setStatuses((prev) => {
      const next: Record<string, ServerStatus> = {};
      for (const srv of srvs) {
        next[srv.name] = prev[srv.name] ?? { status: 'checking', tmux: false };
      }
      return next;
    });

    probeStatuses(srvs);

    return srvs;
  }, [probeStatuses]);

  // sessionStorage への永続化は servers/statuses が変わるたびにまとめて行う
  useEffect(() => {
    persistStatusCache(servers, statuses);
  }, [servers, statuses]);

  // マウント時に即時取得 + 30秒間隔のバックグラウンドポーリング。
  // タブが非表示の間はポーリングをスキップし、復帰時に即時更新する。
  useEffect(() => {
    const warnOnFailure = (err: unknown): void => {
      console.warn('[useServerStatuses] refresh failed:', err);
    };

    refresh().catch(warnOnFailure);

    const interval = setInterval(() => {
      if (document.hidden) return;
      refresh().catch(warnOnFailure);
    }, POLL_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (!document.hidden) refresh().catch(warnOnFailure);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh]);

  return (
    <ServerStatusContext.Provider value={{ servers, statuses, refresh }}>
      {children}
    </ServerStatusContext.Provider>
  );
}

export function useServerStatuses(): ServerStatusContextValue {
  const ctx = useContext(ServerStatusContext);
  if (!ctx) throw new Error('useServerStatuses must be used within a ServerStatusProvider');
  return ctx;
}
