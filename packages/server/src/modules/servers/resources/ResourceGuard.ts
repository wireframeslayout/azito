import type { ServerConfig } from '../Server';
import type { TransportFactory } from '../transport/TransportFactory';
import type { IResourceGuardSettingsRepository } from './SqliteResourceGuardSettingsRepository';
import { AgentUnreachableError } from '../transport/AgentUnreachableError';
import { AgentResourcesOutdatedError, type HostResourceSample } from '../../../shared/os/hostResources';

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
  /** Null: the host has no load average (Windows), so the load is not judged. */
  loadPerCore: number | null;
  memTotalBytes: number;
  memAvailableBytes: number;
  diskUsedPercent: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
}

/** Why a server could not be measured. `agent_outdated`: the agent has no resources endpoint; `unreachable`: the agent cannot be reached; `timeout`: no answer in time; `failed`: the measurement ran but failed or could not be read. */
export type ResourceUnavailableReason = 'agent_outdated' | 'unreachable' | 'timeout' | 'failed';

export interface ResourceUnavailable {
  reason: ResourceUnavailableReason;
}

/** The result of measuring a server: a measurement, or the reason there is none. */
export type MeasureResult =
  | { measurement: ResourceMeasurement; unavailable: null }
  | { measurement: null; unavailable: ResourceUnavailable };

export interface ResourceStatus {
  ok: boolean;
  /** ok=false の原因。fail-open（計測不能・ガード無効）時は空配列 */
  reasons: Array<'memory' | 'load'>;
  memAvailablePercent: number | null;
  loadPerCore: number | null;
  memAvailablePercentMin: number;
  loadPerCoreMax: number;
  /** Set when the check could not be made (the server could not be measured) and was let through (fail-open). Null: it was made, or the guard is disabled. */
  skipped: ResourceUnavailable | null;
}

/** The `resourceCheck` field of a creation response: present only when the resource check was skipped (see `ResourceStatus.skipped`), so the UI can say it was not made. */
export function resourceCheckBody(skipped: ResourceUnavailable | null): { resourceCheck?: { skipped: ResourceUnavailable } } {
  return skipped ? { resourceCheck: { skipped } } : {};
}

export class ResourceExhaustedError extends Error {
  constructor(
    public readonly serverName: string,
    public readonly status: ResourceStatus,
  ) {
    super(
      `Insufficient resources on server '${serverName}': ` +
      `memAvailable=${status.memAvailablePercent}% (min ${status.memAvailablePercentMin}%), ` +
      `loadPerCore=${status.loadPerCore ?? 'n/a'} (max ${status.loadPerCoreMax})`,
    );
    this.name = 'ResourceExhaustedError';
  }
}

/** Thrown inside a measurement when the sh command ran but its result is unusable (non-zero exit, unparsable output). */
class MeasurementFailedError extends Error {}

class MeasurementTimeoutError extends Error {}

/**
 * ウィンドウ作成・エージェント起動前のリソース事前チェック。
 * 計測はサーバー単位で5秒キャッシュし、計測できないときは fail-open
 * （ガード機能の障害で本来の操作を止めない。ただし「飛ばした」ことと理由は ResourceStatus.skipped で返す）。
 * 計測の出どころはホストの OS で決める: Unix（OS 未記録の agent を含む）は sh、Windows は Node の os（agent は /api/host/resources）。
 */
export class ResourceGuard {
  private measureCache = new Map<string, { result: MeasureResult; ts: number }>();
  private readonly inflight = new Map<string, Promise<MeasureResult>>();
  /** The reason last logged for a server, so a server that stays unmeasurable is logged once per reason, not on every check. */
  private readonly warnedReason = new Map<string, ResourceUnavailableReason>();

  constructor(
    private transportFactory: TransportFactory,
    private settingsRepo: IResourceGuardSettingsRepository,
  ) {}

  async check(server: ServerConfig): Promise<ResourceStatus> {
    const settings = this.settingsRepo.get();
    const thresholds = {
      memAvailablePercentMin: settings.memAvailablePercentMin,
      loadPerCoreMax: settings.loadPerCoreMax,
    };
    if (!settings.enabled) {
      return { ok: true, reasons: [], memAvailablePercent: null, loadPerCore: null, ...thresholds, skipped: null };
    }

    const { measurement, unavailable } = await this.measure(server);
    if (!measurement) {
      // fail-open: 計測できない環境ではチェックを飛ばす（飛ばしたことは skipped で呼び出し元に伝える）
      this.warnSkipped(server.name, unavailable.reason);
      return { ok: true, reasons: [], memAvailablePercent: null, loadPerCore: null, ...thresholds, skipped: unavailable };
    }

    const reasons: Array<'memory' | 'load'> = [];
    if (measurement.memAvailablePercent < settings.memAvailablePercentMin) reasons.push('memory');
    // 負荷を計測しないホスト（Windows）では負荷の判定だけを行わない
    if (measurement.loadPerCore !== null && measurement.loadPerCore > settings.loadPerCoreMax) reasons.push('load');

    return {
      ok: reasons.length === 0,
      reasons,
      memAvailablePercent: measurement.memAvailablePercent,
      loadPerCore: measurement.loadPerCore,
      ...thresholds,
      skipped: null,
    };
  }

  /** 実測値を返す（設定に依らない）。計測できないときは measurement=null と理由（5秒キャッシュ） */
  async measure(server: ServerConfig): Promise<MeasureResult> {
    const cached = this.measureCache.get(server.name);
    if (cached && Date.now() - cached.ts < MEASURE_CACHE_TTL) return cached.result;

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

  private warnSkipped(serverName: string, reason: ResourceUnavailableReason): void {
    if (this.warnedReason.get(serverName) === reason) return;
    this.warnedReason.set(serverName, reason);
    console.warn(`[resource-guard] cannot measure server '${serverName}' (${reason}), skipping check (fail-open)`);
  }

  private async doMeasure(server: ServerConfig): Promise<MeasureResult> {
    let result: MeasureResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MeasurementTimeoutError('resource measurement timed out')), MEASURE_TIMEOUT_MS);
      });
      const measurement = await Promise.race([this.measureOnHost(server), timeoutPromise]);
      result = { measurement, unavailable: null };
      this.warnedReason.delete(server.name);
    } catch (err) {
      result = { measurement: null, unavailable: { reason: classifyFailure(err) } };
    } finally {
      if (timer) clearTimeout(timer);
    }

    this.measureCache.set(server.name, { result, ts: Date.now() });
    return result;
  }

  /** The host's OS decides where the values come from. Rejects when they cannot be had. */
  private async measureOnHost(server: ServerConfig): Promise<ResourceMeasurement> {
    const profile = this.transportFactory.hostProfileFor(server);
    if (profile?.platform === 'win32') {
      // exec は POSIX 専用なので sh では測れない。Node で測る
      return measurementFromSample(await this.transportFactory.getTransport(server).measureHostResources());
    }
    const result = await this.transportFactory.getTransport(server).exec(MEASURE_COMMAND);
    const measurement = result.code === 0 ? parseMeasurement(result.stdout) : null;
    if (!measurement) throw new MeasurementFailedError(`measurement command failed (exit ${result.code})`);
    return measurement;
  }
}

function classifyFailure(err: unknown): ResourceUnavailableReason {
  if (err instanceof MeasurementTimeoutError) return 'timeout';
  if (err instanceof AgentResourcesOutdatedError) return 'agent_outdated';
  // The agent client gives up after its own deadline (shorter than ours): that is a timeout, not a lost connection.
  if (err instanceof AgentUnreachableError) return err.reason === 'timeout' ? 'timeout' : 'unreachable';
  return 'failed';
}

/** A Node-measured host has no load average, so `loadPerCore` is null (not 0: an idle host and an unmeasured one differ). */
export function measurementFromSample(sample: HostResourceSample): ResourceMeasurement {
  return {
    memAvailablePercent: (sample.memAvailableBytes / sample.memTotalBytes) * 100,
    loadPerCore: null,
    memTotalBytes: sample.memTotalBytes,
    memAvailableBytes: sample.memAvailableBytes,
    diskUsedPercent: sample.disk ? (sample.disk.usedBytes / sample.disk.totalBytes) * 100 : null,
    diskUsedBytes: sample.disk?.usedBytes ?? null,
    diskTotalBytes: sample.disk?.totalBytes ?? null,
  };
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
