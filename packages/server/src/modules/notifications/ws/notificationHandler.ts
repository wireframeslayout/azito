import type { WebSocket } from 'ws';
import type { NotificationBus } from '../NotificationBus';
import type { NotificationEvent } from '../NotificationEvent';

export function handleNotificationStream(
  ws: WebSocket,
  notificationBus: NotificationBus,
): void {
  console.log('[notificationHandler] client connected');

  const onEvent = (event: NotificationEvent) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  };

  notificationBus.on(onEvent);

  ws.on('close', () => {
    notificationBus.off(onEvent);
  });

  ws.on('error', () => {
    notificationBus.off(onEvent);
  });
}
