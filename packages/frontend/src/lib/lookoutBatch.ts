export type LookoutEventKind = 'attention' | 'finished' | 'failed';
export interface PendingEvent {
  key: string;
  kind: LookoutEventKind;
  title: string;
  at: number;
}
export interface Batch {
  attention: number;
  finished: number;
  failed: number;
  names: string[];
}
export function addEvent<T extends PendingEvent>(queue: readonly T[], event: T): T[] {
  return queue.some(item => item.key === event.key) ? [...queue] : [...queue, event];
}
export function flushBatch(queue: readonly PendingEvent[]): Batch | null {
  if (!queue.length) return null;
  return queue.reduce<Batch>((batch, event) => ({
    ...batch,
    [event.kind]: batch[event.kind] + 1,
    names: batch.names.length < 2 ? [...batch.names, event.title] : batch.names,
  }), { attention: 0, finished: 0, failed: 0, names: [] });
}
