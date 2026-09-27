import { EventEmitter } from 'node:events';

export class MockWebSocket extends EventEmitter {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  terminateCalls = 0;
  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  terminate(): void {
    this.terminateCalls++;
    // Real `ws` behaviour while still CONNECTING (ws/lib/websocket.js emitErrorAndClose).
    this.emit('error', new Error('WebSocket was closed before the connection was established'));
    this.emit('close', 1006, Buffer.alloc(0));
  }
  send(): void {}
  ping(): void {}
  close(): void {}
}

