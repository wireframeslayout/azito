import { formatMuxRef, type MuxRef } from '@azito/shared';
import type { WorkerLaunchRecord } from './workerLaunchRecord';

const PENDING_LAUNCH_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_LAUNCHES = 1024;

/** Holds only validated settings between a successful program start and its window registration. */
export class PendingWorkerLaunches {
  private readonly records = new Map<string, { record: WorkerLaunchRecord; expiresAt: number }>();

  record(serverName: string, ref: MuxRef, record: WorkerLaunchRecord | null): void {
    const key = this.key(serverName, ref);
    this.records.delete(key);
    const now = Date.now();
    for (const [entryKey, entry] of this.records) if (entry.expiresAt <= now) this.records.delete(entryKey);
    if (!record) return;
    if (this.records.size >= MAX_PENDING_LAUNCHES) this.records.delete(this.records.keys().next().value!);
    this.records.set(key, { record, expiresAt: now + PENDING_LAUNCH_TTL_MS });
  }

  take(serverName: string, ref: MuxRef): WorkerLaunchRecord | null {
    const key = this.key(serverName, ref);
    const entry = this.records.get(key);
    this.records.delete(key);
    return entry && entry.expiresAt > Date.now() ? entry.record : null;
  }

  private key(serverName: string, ref: MuxRef): string {
    return JSON.stringify([serverName, formatMuxRef(ref)]);
  }
}
