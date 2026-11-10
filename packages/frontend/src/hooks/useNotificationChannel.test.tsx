import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNotificationChannel, type NotificationHandlers } from './useNotificationChannel';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instance: MockWebSocket;
  readyState = MockWebSocket.CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() { MockWebSocket.instance = this; }
  close() { this.readyState = 3; }
  receive(data: string) { this.onmessage?.({ data } as MessageEvent); }
}

function Subscriber({ handlers }: { handlers: NotificationHandlers }) {
  useNotificationChannel(handlers);
  return null;
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('continues delivery after a listener throws and logs the event type and error to console.error', () => {
  const error = new Error('listener failed');
  const first = vi.fn(() => { throw error; });
  const second = vi.fn();
  render(<><Subscriber handlers={{ onSessionsUpdated: first }} /><Subscriber handlers={{ onSessionsUpdated: second }} /></>);
  act(() => MockWebSocket.instance.receive(JSON.stringify({ type: 'sessions:updated', payload: { serverName: 'local', token: 'secret' } })));
  expect(first).toHaveBeenCalledWith('local');
  expect(second).toHaveBeenCalledWith('local');
  expect(console.error).toHaveBeenCalledExactlyOnceWith('[NotificationChannel] listener failed:', 'sessions:updated', error);
  for (const log of [console.error, console.warn, console.log]) {
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain('secret');
  }
});

it.each(['null', '1', '"text"', '{}', '{"type":1}'])('warns and discards an invalid message shape: %s', (data) => {
  const listener = vi.fn();
  render(<Subscriber handlers={{ onSessionsUpdated: listener }} />);
  act(() => MockWebSocket.instance.receive(data));
  expect(console.warn).toHaveBeenCalledExactlyOnceWith('[NotificationChannel] invalid message shape');
  expect(listener).not.toHaveBeenCalled();
});

it('continues notifying connected listeners after one throws', () => {
  const error = new Error('connected listener failed');
  const first = vi.fn(() => { throw error; });
  const second = vi.fn();
  render(<><Subscriber handlers={{ onConnected: first }} /><Subscriber handlers={{ onConnected: second }} /></>);
  act(() => MockWebSocket.instance.onopen?.());
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledExactlyOnceWith('[NotificationChannel] connected listener failed:', error);
});

it('delivers valid messages and warns without dispatching invalid JSON', () => {
  const listener = vi.fn();
  render(<Subscriber handlers={{ onSessionsUpdated: listener }} />);
  act(() => MockWebSocket.instance.receive('{invalid'));
  expect(listener).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledExactlyOnceWith('[NotificationChannel] invalid message:', expect.any(SyntaxError));
  act(() => MockWebSocket.instance.receive(JSON.stringify({ type: 'sessions:updated', payload: { serverName: 'local' } })));
  expect(listener).toHaveBeenCalledExactlyOnceWith('local');
});
