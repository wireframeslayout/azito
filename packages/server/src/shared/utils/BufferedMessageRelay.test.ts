import { describe, it, expect, vi } from 'vitest';
import { createBufferedMessageRelay } from './BufferedMessageRelay';

describe('createBufferedMessageRelay', () => {
  it('buffers messages pushed before deliverTo() and replays them in order once wired up', () => {
    const relay = createBufferedMessageRelay<string>();
    const handler = vi.fn();

    relay.push('resize');
    relay.push('navigate');
    expect(handler).not.toHaveBeenCalled();

    relay.deliverTo(handler);

    expect(handler.mock.calls.map((c) => c[0])).toEqual(['resize', 'navigate']);
  });

  it('forwards messages directly once deliverTo() has been called', () => {
    const relay = createBufferedMessageRelay<string>();
    const handler = vi.fn();
    relay.deliverTo(handler);

    relay.push('mouseMoved');

    expect(handler).toHaveBeenCalledWith('mouseMoved');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('drops the oldest buffered message once maxBuffered is exceeded', () => {
    const relay = createBufferedMessageRelay<number>({ maxBuffered: 3 });
    relay.push(1);
    relay.push(2);
    relay.push(3);
    relay.push(4); // should evict 1

    const handler = vi.fn();
    relay.deliverTo(handler);

    expect(handler.mock.calls.map((c) => c[0])).toEqual([2, 3, 4]);
  });

  it('clear() discards buffered messages without delivering them', () => {
    const relay = createBufferedMessageRelay<string>();
    relay.push('a');
    relay.push('b');

    relay.clear();

    const handler = vi.fn();
    relay.deliverTo(handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it('drops the oldest buffered messages once the total byte budget is exceeded', () => {
    const relay = createBufferedMessageRelay<string>({
      maxBuffered: 100,
      maxBytes: 10,
      sizeOf: (msg) => msg.length,
    });

    relay.push('12345'); // 5 bytes, total 5
    relay.push('123456'); // 6 bytes, total 11 > 10 -> evicts '12345'

    const handler = vi.fn();
    relay.deliverTo(handler);

    expect(handler.mock.calls.map((c) => c[0])).toEqual(['123456']);
  });

  it('drops a single message outright if it alone exceeds the byte budget', () => {
    const relay = createBufferedMessageRelay<string>({
      maxBytes: 10,
      sizeOf: (msg) => msg.length,
    });

    relay.push('this message is way over the byte budget');
    relay.push('ok');

    const handler = vi.fn();
    relay.deliverTo(handler);

    expect(handler.mock.calls.map((c) => c[0])).toEqual(['ok']);
  });

  it('coalesces messages sharing a key to the latest value, in the original position', () => {
    const relay = createBufferedMessageRelay<{ type: string; v?: number }>({
      coalesceKey: (msg) => (msg.type === 'mouseMoved' ? 'mouseMoved' : null),
    });

    relay.push({ type: 'resize' });
    relay.push({ type: 'mouseMoved', v: 1 });
    relay.push({ type: 'mouseMoved', v: 2 });
    relay.push({ type: 'click' });
    relay.push({ type: 'mouseMoved', v: 3 });

    const handler = vi.fn();
    relay.deliverTo(handler);

    // 'resize' stays first; the three mouseMoved pushes collapse into one
    // entry (latest value) at the position of the *first* mouseMoved, so
    // 'click' still lands after it, not before.
    expect(handler.mock.calls.map((c) => c[0])).toEqual([
      { type: 'resize' },
      { type: 'mouseMoved', v: 3 },
      { type: 'click' },
    ]);
  });

  describe('onOverflow', () => {
    it('is called exactly once when maxBuffered is first exceeded, and further pushes are ignored', () => {
      const onOverflow = vi.fn();
      const relay = createBufferedMessageRelay<number>({ maxBuffered: 2, onOverflow });

      relay.push(1);
      relay.push(2);
      expect(onOverflow).not.toHaveBeenCalled();

      relay.push(3); // evicts 1 -> first overflow
      expect(onOverflow).toHaveBeenCalledTimes(1);

      relay.push(4); // would evict again, but push() is now a no-op
      relay.push(5);
      expect(onOverflow).toHaveBeenCalledTimes(1);

      const handler = vi.fn();
      relay.deliverTo(handler);
      // Only what survived up to (and including) the message that triggered
      // the overflow — nothing pushed after it was ever buffered.
      expect(handler.mock.calls.map((c) => c[0])).toEqual([2, 3]);
    });

    it('is called exactly once when the byte budget is first exceeded', () => {
      const onOverflow = vi.fn();
      const relay = createBufferedMessageRelay<string>({
        maxBuffered: 100,
        maxBytes: 10,
        sizeOf: (msg) => msg.length,
        onOverflow,
      });

      relay.push('12345'); // 5 bytes
      expect(onOverflow).not.toHaveBeenCalled();

      relay.push('123456'); // total 11 > 10 -> evicts '12345', overflow
      expect(onOverflow).toHaveBeenCalledTimes(1);

      relay.push('more'); // ignored: already overflowed
      expect(onOverflow).toHaveBeenCalledTimes(1);
    });

    it('is called when a single oversized message is dropped outright', () => {
      const onOverflow = vi.fn();
      const relay = createBufferedMessageRelay<string>({
        maxBytes: 10,
        sizeOf: (msg) => msg.length,
        onOverflow,
      });

      relay.push('this message is way over the byte budget');
      expect(onOverflow).toHaveBeenCalledTimes(1);
    });

    it('does not fire, and buffering keeps evicting the oldest forever, when onOverflow is not provided', () => {
      const relay = createBufferedMessageRelay<number>({ maxBuffered: 2 });

      for (let i = 0; i < 10; i++) relay.push(i);

      const handler = vi.fn();
      relay.deliverTo(handler);
      // Unaffected by the onOverflow addition: still just the last 2, not an
      // empty buffer from some new "stop accepting" behavior.
      expect(handler.mock.calls.map((c) => c[0])).toEqual([8, 9]);
    });
  });

  // Regression: a burst of high-frequency messages (e.g. mouseMoved fired
  // while Chromium is still starting up) used to be able to push a one-off
  // early message like the client's initial `resize` out of the
  // count-bounded buffer once it filled up. Coalescing mouseMoved down to
  // its latest value means the buffer only ever holds *one* mouseMoved
  // entry no matter how many arrive, so resize (a distinct key) survives.
  it('does not let a burst of coalesced messages evict an earlier, differently-keyed message', () => {
    const relay = createBufferedMessageRelay<{ type: string; v?: number }>({
      maxBuffered: 100,
      coalesceKey: (msg) => (msg.type === 'mouseMoved' ? 'mouseMoved' : null),
    });

    relay.push({ type: 'resize', v: 1 });
    for (let i = 0; i < 150; i++) {
      relay.push({ type: 'mouseMoved', v: i });
    }

    const handler = vi.fn();
    relay.deliverTo(handler);

    expect(handler.mock.calls.map((c) => c[0])).toEqual([
      { type: 'resize', v: 1 },
      { type: 'mouseMoved', v: 149 },
    ]);
  });
});
