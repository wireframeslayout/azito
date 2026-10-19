import { Worker } from 'worker_threads';

export interface RegexMatchRequest {
  /** The expression exactly as the user typed it. */
  pattern: string;
  flags: string;
  texts: string[];
  /** The search ends once this many texts matched. */
  maxMatches: number;
  /** The worker is terminated after this long. */
  timeoutMs: number;
}

export interface RegexMatchResult {
  /** Indexes into `texts`, ascending. On a timeout, the ones found before it. */
  matched: number[];
  timedOut: boolean;
  /** The expression cannot be compiled. */
  invalid: boolean;
}

/**
 * Runs in a worker thread. A user's regular expression can take exponential time on some text (`(a+)+$`); on a worker the
 * deadline can end it with `terminate()`, which the hub's own event loop (tasks, WebSockets) could not survive having stuck.
 * Matches are posted in chunks, so a search that is terminated still has what it found. It is a script (not a file of this
 * package) so that it needs no path, whether the hub runs from source or from the single bundled file.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(() => {
  const { pattern, flags, texts, maxMatches } = workerData;
  let expression;
  try {
    expression = new RegExp(pattern, flags);
  } catch {
    parentPort.postMessage({ type: 'invalid' });
    return;
  }
  const CHUNK = 500;
  let found = 0;
  for (let start = 0; start < texts.length && found < maxMatches; start += CHUNK) {
    const indexes = [];
    const end = Math.min(start + CHUNK, texts.length);
    for (let i = start; i < end && found < maxMatches; i++) {
      if (expression.test(texts[i])) { indexes.push(i); found++; }
    }
    parentPort.postMessage({ type: 'matches', indexes });
  }
  parentPort.postMessage({ type: 'done' });
})();
`;

type WorkerMessage = { type: 'invalid' } | { type: 'done' } | { type: 'matches'; indexes: number[] };

export function matchWithRegex(request: RegexMatchRequest): Promise<RegexMatchResult> {
  return new Promise((resolve, reject) => {
    const matched: number[] = [];
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pattern: request.pattern, flags: request.flags, texts: request.texts, maxMatches: request.maxMatches },
    });
    const finish = (result: RegexMatchResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => finish({ matched, timedOut: true, invalid: false }), Math.max(1, request.timeoutMs));
    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'matches') matched.push(...message.indexes);
      else if (message.type === 'invalid') finish({ matched: [], timedOut: false, invalid: true });
      else finish({ matched, timedOut: false, invalid: false });
    });
    worker.on('error', (err) => finish(err));
    worker.on('exit', () => finish(new Error('The regular expression worker exited before it finished')));
  });
}
