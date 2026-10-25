const HEALTH_CHECK_INTERVAL_MS = 1_000;
const HEALTH_REQUEST_TIMEOUT_MS = 3_000;

/** Polls `/api/health` until it answers with `expectedVersion`; throws with the last failure when `timeoutMs` is over. */
export async function waitForHealthyVersion(healthUrl: string, expectedVersion: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = await res.json() as { version: string };
        if (body.version === expectedVersion) return;
        lastError = `Version mismatch: expected ${expectedVersion}, got ${body.version}`;
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
  }

  throw new Error(`Health check timed out: ${lastError}`);
}

/** The health URL of the hub that listens on `bind:port`; an IPv6 address needs its brackets. */
export function healthUrlOf(bind: string, port: string): string {
  const host = bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind;
  return `http://${host}:${port}/api/health`;
}
