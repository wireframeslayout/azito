// Default cap on how many pre-ready messages we hold onto. A client that
// spams messages before the page is ready (malformed client, or a burst of
// mouse events) must not grow this buffer unbounded; once full, the oldest
// buffered message is dropped to make room for the newest.
const DEFAULT_MAX_BUFFERED = 100;

// Default cap on the total byte size of buffered messages, independent of
// count — a handful of oversized messages could otherwise exhaust memory
// even while staying under DEFAULT_MAX_BUFFERED.
const DEFAULT_MAX_BYTES = 256 * 1024;

export interface BufferedMessageRelayOptions<T> {
  /** Max number of buffered entries before the oldest is evicted. */
  maxBuffered?: number;
  /** Max total size (in whatever unit `sizeOf` returns) of buffered entries. */
  maxBytes?: number;
  /** Computes a message's size for the `maxBytes` budget. Defaults to 0 (no byte-based eviction). */
  sizeOf?: (msg: T) => number;
  /**
   * Returns a coalescing key for a message, or `null` to buffer it as a
   * normal, independently-kept entry. When a non-null key matches an
   * already-buffered entry, the new message replaces that entry *in place*
   * (same position, so arrival order of the other entries is preserved)
   * instead of being appended — e.g. so a burst of `mouseMoved` events
   * collapses to the latest one and can't push an earlier `resize` out of
   * a count-bounded buffer.
   */
  coalesceKey?: (msg: T) => string | null;
  /**
   * Called exactly once, the moment a message is actually dropped because
   * the buffer is full (count or byte cap) — never for a normal coalescing
   * replace. Once called, `push()` becomes a permanent no-op (every
   * subsequent message is silently ignored too): this option is for
   * consumers where losing even one buffered message is unrecoverable (e.g.
   * a CDP command stream, where DevTools would hang forever waiting on a
   * response to a request that never arrived) and the right response is to
   * tear the whole connection down rather than keep sliding the window.
   * Omit it (as the drop-oldest default) for consumers where losing an old
   * buffered message is fine — e.g. input events, where the buffer should
   * just keep evicting the oldest and carry on.
   */
  onOverflow?: () => void;
}

export interface BufferedMessageRelay<T> {
  /**
   * Feed one message in. Before `deliverTo()` has been called, the message
   * is appended to (or coalesced into) an internal buffer, subject to the
   * count/byte caps. After `deliverTo()`, messages are forwarded
   * synchronously to the registered handler.
   */
  push(msg: T): void;
  /**
   * Register the real handler and flush any messages buffered so far to it,
   * in (post-coalescing) arrival order. All subsequent `push()` calls go
   * straight to `handler`.
   */
  deliverTo(handler: (msg: T) => void): void;
  /** Discard any buffered (not yet delivered) messages, e.g. on early close. */
  clear(): void;
}

interface BufferedEntry<T> {
  msg: T;
  size: number;
  key: string | null;
}

/**
 * Byte size for a WS message (Buffer or string), for use as `sizeOf` against
 * `maxBytes`. `msg.toString().length` (what both callers used before) counts
 * UTF-16 code units for a string and undercounts a Buffer's actual byte
 * length for any non-ASCII content — `Buffer.byteLength` measures the real
 * UTF-8 byte size a string message would occupy, and `Buffer.isBuffer`
 * avoids re-decoding an already-binary message through toString() first.
 */
export function messageByteSize(msg: Buffer | string): number {
  return Buffer.isBuffer(msg) ? msg.byteLength : Buffer.byteLength(msg);
}

/**
 * Bridges the gap between "a WS connection starts receiving messages" and
 * "the async setup needed to actually process them is ready" (e.g. a
 * BrowserSession/BrowserPage that must be fetched/created before dispatching
 * input). Messages pushed before `deliverTo()` is called are buffered
 * instead of being silently dropped, then replayed once the real handler is
 * wired up.
 *
 * Bounded on two axes — count (`maxBuffered`) and total size (`maxBytes`) —
 * and supports coalescing high-frequency message types (e.g. `mouseMoved`)
 * to their latest value so they can't crowd out a one-off but important
 * early message (e.g. the client's initial `resize`) out of a count-limited
 * buffer.
 */
export function createBufferedMessageRelay<T>(options: BufferedMessageRelayOptions<T> = {}): BufferedMessageRelay<T> {
  const maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const sizeOf = options.sizeOf ?? (() => 0);
  const coalesceKey = options.coalesceKey ?? (() => null);
  const onOverflow = options.onOverflow;

  let buffer: BufferedEntry<T>[] = [];
  let totalBytes = 0;
  let handler: ((msg: T) => void) | null = null;
  // Latches once onOverflow has fired, so push() stops accepting anything
  // further. Only ever set when onOverflow is configured — without it,
  // behavior is unchanged from before this option existed (evict oldest,
  // keep going forever).
  let overflowed = false;

  const evictOldest = (): void => {
    const removed = buffer.shift();
    if (removed) totalBytes -= removed.size;
  };

  const enforceCaps = (): boolean => {
    let evicted = false;
    while (buffer.length > maxBuffered) { evictOldest(); evicted = true; }
    while (totalBytes > maxBytes && buffer.length > 0) { evictOldest(); evicted = true; }
    return evicted;
  };

  const reportOverflow = (): void => {
    if (!onOverflow) return;
    overflowed = true;
    onOverflow();
  };

  return {
    push(msg: T): void {
      if (overflowed) return;

      if (handler) {
        handler(msg);
        return;
      }

      const size = sizeOf(msg);
      // A single message larger than the entire byte budget can never fit
      // (even after evicting everything else); drop it outright — this is
      // itself a drop, so it counts as an overflow too.
      if (size > maxBytes) {
        reportOverflow();
        return;
      }

      const key = coalesceKey(msg);
      if (key !== null) {
        const idx = buffer.findIndex((entry) => entry.key === key);
        if (idx >= 0) {
          totalBytes += size - buffer[idx].size;
          buffer[idx] = { msg, size, key };
          if (enforceCaps()) reportOverflow();
          return;
        }
      }

      buffer.push({ msg, size, key });
      totalBytes += size;
      if (enforceCaps()) reportOverflow();
    },
    deliverTo(h: (msg: T) => void): void {
      const pending = buffer;
      buffer = [];
      totalBytes = 0;
      handler = h;
      for (const entry of pending) h(entry.msg);
    },
    clear(): void {
      buffer = [];
      totalBytes = 0;
    },
  };
}
