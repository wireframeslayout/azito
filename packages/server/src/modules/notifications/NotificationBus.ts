import { EventEmitter } from 'node:events';
import type { NotificationEvent } from './NotificationEvent';

export class NotificationBus {
  private emitter = new EventEmitter();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  emit(event: NotificationEvent): void {
    if (event.type === 'sessions:updated') {
      const key = `sessions:${event.payload.serverName}`;
      const existing = this.debounceTimers.get(key);
      if (existing) clearTimeout(existing);
      this.debounceTimers.set(key, setTimeout(() => {
        this.debounceTimers.delete(key);
        this.emitter.emit('event', event);
      }, 500));
      return;
    }
    this.emitter.emit('event', event);
  }

  on(listener: (event: NotificationEvent) => void): void {
    this.emitter.on('event', listener);
  }

  off(listener: (event: NotificationEvent) => void): void {
    this.emitter.off('event', listener);
  }

  destroy(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.emitter.removeAllListeners();
  }
}
