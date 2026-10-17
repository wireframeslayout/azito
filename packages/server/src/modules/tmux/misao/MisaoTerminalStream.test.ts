import { describe, expect, it, vi } from 'vitest';
import type { MisaoAttachClient } from './MisaoConnection';
import { MisaoTerminalStream } from './MisaoTerminalStream';

class FakeRpcError extends Error {
  constructor(readonly code: number) { super(`rpc ${code}`); }
}

type Listener<T> = (value: T) => void;

function fakeClient() {
  const notifications: Array<Listener<unknown>> = [];
  const states: Array<Listener<unknown>> = [];
  const events: Array<Listener<unknown>> = [];
  const request = vi.fn(async (_method: string, _params: Record<string, unknown>): Promise<unknown> => ({}));
  const client = {
    request,
    onNotification: (cb: Listener<unknown>) => { notifications.push(cb); return () => {}; },
    onStateChange: (cb: Listener<unknown>) => { states.push(cb); return () => {}; },
    subscribeEvents: async (cb: Listener<unknown>) => { events.push(cb); return { unsubscribe: () => {}, cursor: { seq: 0, epoch: 'e' } }; },
    close: vi.fn(),
  };
  const output = (paneId: string, bytes: Buffer) => { for (const n of notifications) n({ method: 'pane.output', params: { paneId, dataB64: bytes.toString('base64') } }); };
  return { client, request, output, state: (s: unknown) => { for (const l of states) l(s); }, event: (e: unknown) => { for (const l of events) l(e); } };
}

async function open(fake = fakeClient()) {
  const warn = vi.fn();
  const stream = await MisaoTerminalStream.open({
    client: fake.client as unknown as MisaoAttachClient,
    paneId: 'p_1',
    clientId: 'azito-term-1',
    cols: 100,
    rows: 30,
    log: { warn },
    rpcErrorCode: (err) => (err instanceof FakeRpcError ? err.code : undefined),
  });
  const data: string[] = [];
  const closed = vi.fn();
  stream.on('data', (d: string) => data.push(d));
  stream.on('close', closed);
  return { fake, stream, data, closed, warn };
}

describe('MisaoTerminalStream', () => {
  it('attaches as a raw client with a snapshot replay', async () => {
    const { fake } = await open();
    expect(fake.request).toHaveBeenCalledWith('pane.attach', { paneId: 'p_1', clientId: 'azito-term-1', mode: 'raw', replay: 'snapshot', cols: 100, rows: 30 });
  });

  it('does not lose the snapshot that arrives before the first data listener', async () => {
    const fake = fakeClient();
    fake.request.mockImplementation(async (method) => {
      if (method === 'pane.attach') fake.output('p_1', Buffer.from('snap'));
      return {};
    });
    const { data } = await open(fake);
    await vi.waitFor(() => expect(data).toEqual(['snap']));
  });

  it('does not lose a pane.closed that arrives with the attach reply, before anyone listens', async () => {
    const fake = fakeClient();
    fake.request.mockImplementation(async (method) => {
      if (method === 'pane.attach') {
        fake.output('p_1', Buffer.from('snap'));
        fake.event({ type: 'pane.closed', paneId: 'p_1' });
      }
      return {};
    });
    const { data, closed } = await open(fake);
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(data).toEqual(['snap']);
    expect(fake.client.close).toHaveBeenCalledTimes(1);
  });

  it('emits only the output of its own pane', async () => {
    const { fake, data } = await open();
    fake.output('p_other', Buffer.from('x'));
    fake.output('p_1', Buffer.from('hi'));
    expect(data).toEqual(['hi']);
  });

  it('keeps a multi-byte character split across chunks together', async () => {
    const { fake, data } = await open();
    const bytes = Buffer.from('あ');
    fake.output('p_1', bytes.subarray(0, 2));
    fake.output('p_1', bytes.subarray(2));
    expect(data).toEqual(['あ']);
  });

  it('sends input and resizes with its client id', async () => {
    const { fake, stream } = await open();
    stream.write('ls\r');
    stream.resize(90, 20);
    expect(fake.request).toHaveBeenCalledWith('pane.write', { paneId: 'p_1', data: 'ls\r', clientId: 'azito-term-1', source: 'terminal' });
    expect(fake.request).toHaveBeenCalledWith('pane.resize', { paneId: 'p_1', cols: 90, rows: 20, clientId: 'azito-term-1' });
  });

  it('closes when its pane is closed, ignoring other panes and exits', async () => {
    const { fake, stream, closed } = await open();
    fake.event({ type: 'pane.closed', paneId: 'p_other' });
    fake.event({ type: 'pane.exited', paneId: 'p_1' });
    expect(closed).not.toHaveBeenCalled();
    fake.event({ type: 'pane.closed', paneId: 'p_1' });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(fake.client.close).toHaveBeenCalledTimes(1);
    expect(stream).toMatchObject({ closeCode: 4413, closeReason: 'pane closed' });
  });

  it('closes without a close code when the daemon connection is lost, so the browser reconnects', async () => {
    const { fake, stream, closed } = await open();
    fake.state({ status: 'reconnecting', attempt: 1, delayMs: 100, cause: new Error('x') });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(stream.closeCode).toBeUndefined();
  });

  it('closes when the daemon connection is lost', async () => {
    const { fake, closed } = await open();
    fake.state({ status: 'connected' });
    expect(closed).not.toHaveBeenCalled();
    fake.state({ status: 'reconnecting', attempt: 1, delayMs: 100, cause: new Error('x') });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('drops writes to an exited pane silently', async () => {
    const { fake, stream, closed, warn } = await open();
    fake.request.mockRejectedValueOnce(new FakeRpcError(1002));
    stream.write('x');
    await vi.waitFor(() => expect(fake.request).toHaveBeenCalledWith('pane.write', expect.anything()));
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs and closes on any other request failure', async () => {
    const { fake, stream, closed, warn } = await open();
    fake.request.mockRejectedValueOnce(new Error('boom'));
    stream.resize(80, 24);
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('close() closes the connection once without emitting close', async () => {
    const { fake, stream, closed } = await open();
    stream.close();
    stream.close();
    expect(fake.client.close).toHaveBeenCalledTimes(1);
    expect(closed).not.toHaveBeenCalled();
  });

  it('ignores input after it finished, including requests that were in flight', async () => {
    const { fake, stream, warn } = await open();
    let rejectInFlight: (err: unknown) => void = () => {};
    fake.request.mockImplementationOnce(() => new Promise((_, reject) => { rejectInFlight = reject; }));
    stream.write('a');
    stream.close();
    rejectInFlight(new Error('connection closed'));
    stream.write('b');
    stream.resize(80, 24);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.request.mock.calls.filter(([method]) => method !== 'pane.attach')).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects when the attach fails', async () => {
    const fake = fakeClient();
    fake.request.mockRejectedValueOnce(new FakeRpcError(1001));
    await expect(open(fake)).rejects.toBeInstanceOf(FakeRpcError);
  });
});
