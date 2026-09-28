import { useEffect, useRef } from 'react';
import type { AgentActivityPayload, BrowserOpenedPayload, NotificationEvent } from '../types/notification';
import { buildWsUrl } from '../api/wsUrl';

export interface NotificationHandlers {
  onSessionsUpdated?: (serverName: string) => void;
  onTaskStatus?: (payload: { taskId: number; status: string; title?: string; projectId?: number }) => void;
  onPaneExited?: (serverName: string) => void;
  onAgentActivity?: (payload: AgentActivityPayload) => void;
  onBrowserOpened?: (payload: BrowserOpenedPayload) => void;
  onSupervisorReady?: (payload: { serverName: string; target: string; taskId?: number }) => void;
  onWorkspaceRefresh?: () => void;
  /** Fired on every WebSocket (re)connect — use to re-fetch snapshot state. */
  onConnected?: () => void;
}

type Listener = (event: NotificationEvent) => void;

let sharedWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;
let refCount = 0;
const listeners = new Set<Listener>();
const connectedListeners = new Set<() => void>();

function dispatch(event: NotificationEvent): void {
  for (const fn of listeners) fn(event);
}

function connect(): void {
  if (sharedWs && (sharedWs.readyState === WebSocket.CONNECTING || sharedWs.readyState === WebSocket.OPEN)) return;

  const ws = new WebSocket(buildWsUrl({ mode: 'events' }));
  sharedWs = ws;

  ws.onopen = () => {
    retryCount = 0;
    console.log('[NotificationChannel] WebSocket connected');
    for (const fn of connectedListeners) fn();
  };

  ws.onmessage = (e) => {
    try {
      const event: NotificationEvent = JSON.parse(e.data);
      console.log('[NotificationChannel] event received:', event.type, JSON.stringify(event.payload));
      dispatch(event);
    } catch { /* ignore */ }
  };

  ws.onclose = (ev) => {
    console.log('[NotificationChannel] WebSocket closed, code:', ev.code, 'reason:', ev.reason);
    sharedWs = null;
    if (refCount <= 0) return;
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
    retryCount++;
    console.log('[NotificationChannel] reconnecting in', delay, 'ms (attempt', retryCount, ')');
    reconnectTimer = setTimeout(connect, delay);
  };

  ws.onerror = () => { /* close will follow */ };
}

function subscribe(listener: Listener): void {
  listeners.add(listener);
  refCount++;
  console.log('[NotificationChannel] subscribe, refCount:', refCount, 'listeners:', listeners.size);
  if (refCount === 1) connect();
}

function unsubscribe(listener: Listener): void {
  listeners.delete(listener);
  refCount--;
  console.log('[NotificationChannel] unsubscribe, refCount:', refCount, 'listeners:', listeners.size);
  if (refCount <= 0) {
    refCount = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (sharedWs) { sharedWs.onclose = null; sharedWs.close(); sharedWs = null; }
    retryCount = 0;
  }
}

export function useNotificationChannel(handlers: NotificationHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const listener: Listener = (event) => {
      const h = handlersRef.current;
      switch (event.type) {
        case 'sessions:updated':
          h.onSessionsUpdated?.(event.payload.serverName);
          break;
        case 'task:status':
          h.onTaskStatus?.(event.payload);
          break;
        case 'pane:exited':
          h.onPaneExited?.(event.payload.serverName);
          break;
        case 'agent:activity':
          h.onAgentActivity?.(event.payload);
          break;
        case 'browser:opened':
          h.onBrowserOpened?.(event.payload);
          break;
        case 'supervisor:ready':
          h.onSupervisorReady?.(event.payload);
          break;
        case 'workspace:refresh':
          h.onWorkspaceRefresh?.();
          break;
      }
    };
    const connectedListener = () => handlersRef.current.onConnected?.();

    subscribe(listener);
    connectedListeners.add(connectedListener);
    return () => {
      unsubscribe(listener);
      connectedListeners.delete(connectedListener);
    };
  }, []);
}
