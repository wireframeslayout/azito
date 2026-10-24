import { Worker } from 'worker_threads';
import { CONTENT_SEARCH_MAX_FILE_BYTES, CONTENT_SEARCH_MAX_HITS_PER_FILE, type ContentSearchHit, type ContentSearchOptions } from './fileOps';

/** Files one content search looks at at most (the walk stops there, like the file name search). */
export const CONTENT_SEARCH_MAX_FILES = 200_000;

export interface ContentScanFile {
  /** Where the file is, in the host's notation. */
  absolute: string;
  /** Reported as the hit's path: relative to the searched root, with `/`. */
  relative: string;
}

export interface ContentScanResult {
  hits: ContentSearchHit[];
  /** The worker was ended by the deadline; `hits` are the ones it had found. */
  timedOut: boolean;
  /** The expression cannot be compiled. */
  invalid: boolean;
}

/**
 * Runs in a worker thread, for two reasons: a user's regular expression can take exponential time on some line (`(a+)+$`), which
 * only `terminate()` can end without freezing the process's event loop (the hub's tasks and WebSockets, an agent's requests); and
 * reading many files would hold that loop too. Hits are posted per file, so a search that is terminated still has what it found.
 * It is a script (not a file of this package) so that it needs no path, whether the process runs from source or from the single
 * bundled file. A text query has been turned into an escaped expression by the caller.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
(() => {
  const { files, pattern, flags, wholeWord, maxHits, perFile, maxBytes } = workerData;
  let expression;
  try {
    new RegExp(pattern, flags);
    const word = '[A-Za-z0-9_]';
    expression = new RegExp(wholeWord ? '(?<!' + word + ')(?:' + pattern + ')(?!' + word + ')' : pattern, flags);
  } catch {
    parentPort.postMessage({ type: 'invalid' });
    return;
  }
  let total = 0;
  for (const file of files) {
    if (total >= maxHits) break;
    let data;
    try {
      const stats = fs.statSync(file.absolute);
      if (!stats.isFile() || stats.size > maxBytes) continue;
      data = fs.readFileSync(file.absolute);
    } catch {
      continue;
    }
    if (data.indexOf(0) !== -1) continue;
    const lines = data.toString('utf8').split('\\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const hits = [];
    for (let i = 0; i < lines.length && hits.length < perFile && total + hits.length < maxHits; i++) {
      const text = lines[i].endsWith('\\r') ? lines[i].slice(0, -1) : lines[i];
      const found = expression.exec(text);
      if (found) hits.push({ path: file.relative, line: i + 1, column: found.index + 1, text, matchStart: found.index, matchEnd: found.index + found[0].length });
    }
    if (hits.length > 0) {
      total += hits.length;
      parentPort.postMessage({ type: 'hits', hits });
    }
  }
  parentPort.postMessage({ type: 'done' });
})();
`;

type WorkerMessage = { type: 'invalid' } | { type: 'done' } | { type: 'hits'; hits: ContentSearchHit[] };

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Searches `files`, in order, for the lines that match `options`, in a worker thread that is terminated after `timeoutMs`. At most
 * `options.maxHits` hits, and {@link CONTENT_SEARCH_MAX_HITS_PER_FILE} per file. A file that cannot be read, is larger than
 * {@link CONTENT_SEARCH_MAX_FILE_BYTES} or holds a NUL byte (a binary file) is passed over.
 */
export function scanFilesForContent(files: ContentScanFile[], options: ContentSearchOptions, timeoutMs: number): Promise<ContentScanResult> {
  return new Promise((resolve, reject) => {
    const hits: ContentSearchHit[] = [];
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        files,
        pattern: options.regex ? options.query : escapeForRegExp(options.query),
        flags: options.caseSensitive ? '' : 'i',
        wholeWord: options.wholeWord,
        maxHits: options.maxHits,
        perFile: CONTENT_SEARCH_MAX_HITS_PER_FILE,
        maxBytes: CONTENT_SEARCH_MAX_FILE_BYTES,
      },
    });
    const finish = (result: ContentScanResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => finish({ hits, timedOut: true, invalid: false }), Math.max(1, timeoutMs));
    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'hits') hits.push(...message.hits);
      else if (message.type === 'invalid') finish({ hits: [], timedOut: false, invalid: true });
      else finish({ hits, timedOut: false, invalid: false });
    });
    worker.on('error', (err) => finish(err));
    worker.on('exit', () => finish(new Error('The content search worker exited before it finished')));
  });
}
