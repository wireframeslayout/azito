import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

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
