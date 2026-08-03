import type { ServerConfig } from '../Server';
import type { TransportFactory } from '../transport/TransportFactory';
import type { IResourceGuardSettingsRepository } from './SqliteResourceGuardSettingsRepository';

/** 1回の exec でメモリ・コア数・loadavg・ディスクをまとめて取得する */
const LINUX_MEASURE = "free -b | awk '/^Mem:/{print $2, $7}'; nproc; cat /proc/loadavg; df -B1 --output=used,size / 2>/dev/null | tail -1";

// macOS has none of the above: no `free`, no `nproc`, no /proc, and BSD `df`
// rejects --output. These emit the same four lines from sysctl/vm_stat so
// parseMeasurement stays platform-agnostic. Absolute paths because sysctl lives
// in /usr/sbin, which not every caller's PATH includes.
// "Available" has no direct macOS equivalent; free + inactive + speculative +
// purgeable is the reclaimable set, which is what MemAvailable approximates.
const DARWIN_MEASURE = [
  'PS=$(/usr/bin/vm_stat | sed -n \'s/.*page size of \\([0-9]*\\) bytes.*/\\1/p\')',
  'AV=$(/usr/bin/vm_stat | awk -v ps="$PS" \'/Pages free/{f=$3} /Pages inactive/{i=$3} /Pages speculative/{s=$3} /Pages purgeable/{p=$3} END{gsub(/\\./,"",f);gsub(/\\./,"",i);gsub(/\\./,"",s);gsub(/\\./,"",p); print (f+i+s+p)*ps}\')',
  'echo "$(/usr/sbin/sysctl -n hw.memsize) $AV"',
  '/usr/sbin/sysctl -n hw.ncpu',
  '/usr/sbin/sysctl -n vm.loadavg | tr -d \'{}\'',
  'df -k / | tail -1 | awk \'{print $3*1024, $2*1024}\'',
].join('; ');

export const MEASURE_COMMAND = `if [ "$(uname -s)" = Darwin ]; then ${DARWIN_MEASURE}; else ${LINUX_MEASURE}; fi`;

const MEASURE_CACHE_TTL = 5000;

/** 到達不能な agent サーバー等で exec が無期限に pending になるのを防ぐタイムアウト */
const MEASURE_TIMEOUT_MS = 10000;

export interface ResourceMeasurement {
  memAvailablePercent: number;
  loadPerCore: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  diskUsedPercent: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
}

export interface ResourceStatus {
  ok: boolean;
  /** ok=false の原因。fail-open（計測不能・ガード無効）時は空配列 */
  reasons: Array<'memory' | 'load'>;
  memAvailablePercent: number | null;
  loadPerCore: number | null;
  memAvailablePercentMin: number;
  loadPerCoreMax: number;
}

export class ResourceExhaustedError extends Error {
  constructor(
    public readonly serverName: string,
    public readonly status: ResourceStatus,
  ) {
    super(
      `Insufficient resources on server '${serverName}': ` +
      `memAvailable=${status.memAvailablePercent}% (min ${status.memAvailablePercentMin}%), ` +
      `loadPerCore=${status.loadPerCore} (max ${status.loadPerCoreMax})`,
    );
    this.name = 'ResourceExhaustedError';
  }
}

/**
 * ウィンドウ作成・エージェント起動前のリソース事前チェック。
 * 計測はサーバー単位で5秒キャッシュし、取得・パース失敗時は fail-open
 * （ガード機能の障害で本来の操作を止めない）。
 */
export class ResourceGuard {
  private measureCache = new Map<string, { measurement: ResourceMeasurement | null; ts: number }>();
  private readonly inflight = new Map<string, Promise<ResourceMeasurement | null>>();

  constructor(
    private transportFactory: TransportFactory,
    private settingsRepo: IResourceGuardSettingsRepository,
  ) {}

  async check(server: ServerConfig): Promise<ResourceStatus> {
    const settings = this.settingsRepo.get();
    if (!settings.enabled) {
      return {
        ok: true,
        reasons: [],
        memAvailablePercent: null,
        loadPerCore: null,
        memAvailablePercentMin: settings.memAvailablePercentMin,
        loadPerCoreMax: settings.loadPerCoreMax,
      };
    }

    const measurement = await this.measure(server);
    if (!measurement) {
      // fail-open: 計測できない環境（コマンド不在等）ではチェックをスキップ
      console.warn(`[resource-guard] measurement failed on server '${server.name}', skipping check (fail-open)`);
      return {
        ok: true,
        reasons: [],
        memAvailablePercent: null,
        loadPerCore: null,
        memAvailablePercentMin: settings.memAvailablePercentMin,
        loadPerCoreMax: settings.loadPerCoreMax,
      };
    }

    const reasons: Array<'memory' | 'load'> = [];
    if (measurement.memAvailablePercent < settings.memAvailablePercentMin) reasons.push('memory');
    if (measurement.loadPerCore > settings.loadPerCoreMax) reasons.push('load');

    return {
      ok: reasons.length === 0,
      reasons,
      memAvailablePercent: measurement.memAvailablePercent,
      loadPerCore: measurement.loadPerCore,
      memAvailablePercentMin: settings.memAvailablePercentMin,
      loadPerCoreMax: settings.loadPerCoreMax,
    };
  }

  /** 実測値を返す（設定に依らない）。取得失敗時は null（5秒キャッシュ） */
  async measure(server: ServerConfig): Promise<ResourceMeasurement | null> {
    const cached = this.measureCache.get(server.name);
    if (cached && Date.now() - cached.ts < MEASURE_CACHE_TTL) return cached.measurement;

    const existing = this.inflight.get(server.name);
    if (existing) return existing;

    const promise = this.doMeasure(server);
    this.inflight.set(server.name, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(server.name);
    }
  }

  private async doMeasure(server: ServerConfig): Promise<ResourceMeasurement | null> {
    let measurement: ResourceMeasurement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const execPromise = this.transportFactory.getTransport(server).exec(MEASURE_COMMAND);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('resource measurement timed out')), MEASURE_TIMEOUT_MS);
      });
      const result = await Promise.race([execPromise, timeoutPromise]);
      if (result.code === 0) measurement = parseMeasurement(result.stdout);
    } catch {
      measurement = null;
    } finally {
      if (timer) clearTimeout(timer);
    }

    this.measureCache.set(server.name, { measurement, ts: Date.now() });
    return measurement;
  }
}

/**
 * MEASURE_COMMAND の出力をパースする。期待形式:
 *   <memTotalBytes> <memAvailableBytes>
 *   <nproc>
 *   <load1> <load5> <load15> ...
 *   <diskUsedBytes> <diskTotalBytes>     (optional — df may not be available)
 */
export function parseMeasurement(stdout: string): ResourceMeasurement | null {
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 3) return null;

  const [memTotal, memAvailable] = lines[0].split(/\s+/).map(Number);
  const nproc = Number(lines[1]);
  const load1 = Number(lines[2].split(/\s+/)[0]);

  if (!Number.isFinite(memTotal) || memTotal <= 0) return null;
  if (!Number.isFinite(memAvailable) || memAvailable < 0) return null;
  if (!Number.isFinite(nproc) || nproc <= 0) return null;
  if (!Number.isFinite(load1) || load1 < 0) return null;

  let diskUsedPercent: number | null = null;
  let diskUsedBytes: number | null = null;
  let diskTotalBytes: number | null = null;
  if (lines.length >= 4) {
    const dfParts = lines[3].split(/\s+/).map(Number);
    if (dfParts.length >= 2 && Number.isFinite(dfParts[0]) && Number.isFinite(dfParts[1]) && dfParts[1] > 0) {
      diskUsedBytes = dfParts[0];
      diskTotalBytes = dfParts[1];
      diskUsedPercent = (dfParts[0] / dfParts[1]) * 100;
    }
  }

  return {
    memAvailablePercent: (memAvailable / memTotal) * 100,
    loadPerCore: load1 / nproc,
    memTotalBytes: memTotal,
    memAvailableBytes: memAvailable,
    diskUsedPercent,
    diskUsedBytes,
    diskTotalBytes,
  };
}
