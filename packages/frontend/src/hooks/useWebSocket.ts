import { useCallback, useEffect, useRef, useState } from 'react';

export function useWebSocket(
  url: string | null,
  onMessage: (data: string) => void,
): {
  send: (data: string) => void;
  readyState: number;
} {
  const wsRef = useRef<WebSocket | null>(null);
  const [readyState, setReadyState] = useState<number>(WebSocket.CLOSED);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!url) {
      setReadyState(WebSocket.CLOSED);
      return;
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const fullUrl = url.startsWith('ws') ? url : `${proto}//${location.host}${url}`;
    const ws = new WebSocket(fullUrl);
    wsRef.current = ws;

    ws.onopen = () => setReadyState(WebSocket.OPEN);

    ws.onmessage = (event) => {
      onMessageRef.current(event.data);
    };

    ws.onclose = () => {
      setReadyState(WebSocket.CLOSED);
    };

    ws.onerror = () => {
      setReadyState(WebSocket.CLOSED);
    };

    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [url]);

  const send = useCallback((data: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  return { send, readyState };
}
