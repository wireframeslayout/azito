import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useToast } from './useToast';

export type HealthLevel = 'healthy' | 'warning' | 'critical';

interface ResourceMeasurement {
  memAvailablePercent: number;
  loadPerCore: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  diskUsedPercent: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
}

export interface ServerResourceEntry {
  serverName: string;
  type: string;
  measurement: ResourceMeasurement | null;
}

interface AllServersResourceData {
  enabled: boolean;
  memAvailablePercentMin: number;
  loadPerCoreMax: number;
  servers: ServerResourceEntry[];
}

export interface ServerResourceDetail {
  serverName: string;
  type: string;
  measurement: ResourceMeasurement | null;
  windows?: Array<{ target: string; rssBytes: number }>;
}

export function getHealthLevel(measurement: ResourceMeasurement | null): HealthLevel {
  if (!measurement) return 'critical';
  const memUsedPercent = 100 - measurement.memAvailablePercent;
  if (memUsedPercent >= 85) return 'critical';
  if (memUsedPercent >= 60) return 'warning';
  return 'healthy';
}

export function getWorstHealth(levels: HealthLevel[]): HealthLevel {
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('warning')) return 'warning';
  return 'healthy';
}

export function useServerResources(intervalMs: number) {
  const [data, setData] = useState<AllServersResourceData | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const result = await api<AllServersResourceData>('/servers/resources');
      setData(result);
    } catch {
      // fail-open: leave existing data
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, intervalMs);
    return () => clearInterval(id);
  }, [fetchData, intervalMs]);

  return { data, refresh: fetchData };
}

const ServerResourcesContext = createContext<ServerResourceEntry[]>([]);

export function ServerResourcesProvider({ servers, children }: { servers: ServerResourceEntry[]; children: React.ReactNode }) {
  return <ServerResourcesContext.Provider value={servers}>{children}</ServerResourcesContext.Provider>;
}

export function useServerResourcesContext(): ServerResourceEntry[] {
  return useContext(ServerResourcesContext);
}

export async function fetchServerResourceDetail(serverName: string): Promise<ServerResourceDetail | null> {
  try {
    return await api<ServerResourceDetail>(`/servers/${encodeURIComponent(serverName)}/resources?detail=1`);
  } catch {
    return null;
  }
}

/**
 * サーバー1台分の詳細リソース（MEM/CPU/DISK・ウィンドウ別メモリ）をポーリングし、ウィンドウの
 * 強制終了操作もまとめて提供する。デスクトップの `ResourceDropdownContent` と SP の
 * `ServerHealthSheet`（Issue #69 T6）が共有する（ポーリング・削除ロジックの重複禁止）。
 */
export function useServerResourceDetail(serverName: string) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const [detail, setDetail] = useState<ServerResourceDetail | null>(null);
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    const result = await fetchServerResourceDetail(serverName);
    setDetail(result);
  }, [serverName]);

  useEffect(() => {
    fetchDetail();
    const id = setInterval(fetchDetail, 5000);
    return () => clearInterval(id);
  }, [fetchDetail]);

  const handleDeleteWindow = useCallback(async (target: string) => {
    setDeleteLoading(target);
    try {
      await api(`/servers/${encodeURIComponent(serverName)}/windows/${encodeURIComponent(target)}`, { method: 'DELETE' });
      fetchDetail();
    } catch (e) {
      showToast(t('statusbar.deleteFailed', { error: (e as Error).message }));
    } finally {
      setDeleteLoading(null);
    }
  }, [serverName, fetchDetail, showToast, t]);

  return { detail, deleteLoading, handleDeleteWindow };
}
