import { Worker } from 'worker_threads';
import { CONTENT_SEARCH_MAX_FILE_BYTES, CONTENT_SEARCH_MAX_HITS_PER_FILE, CONTENT_SEARCH_MAX_LINE_CHARS, CONTENT_SEARCH_MAX_RESULT_BYTES, type ContentSearchHit, type ContentSearchOptions } from './fileOps';

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
  /** The text of the hits reached {@link CONTENT_SEARCH_MAX_RESULT_BYTES}: the remaining files were not searched. */
  cut: boolean;
}

/**
 * Runs in a worker thread, for two reasons: a user's regular expression can take exponential time on some line (`(a+)+$`), which
 * only `terminate()` can end without freezing the process's event loop (the hub's tasks and WebSockets, an agent's requests); and
 * reading many files would hold that loop too. Hits are posted per file, so a search that is terminated still has what it found.
 * It is a script (not a file of this package) so that it needs no path, whether the process runs from source or from the single
 * bundled file. A text query has been turned into an escaped expression by the caller.
 *
 * Each file was found by a walk some time ago, so it is checked again as it is read: it is opened without following a link where the
 * OS can (`O_NOFOLLOW`), must be a regular file by the handle's own `fstat`, and its real path (every directory above it included)
 * must still be inside the real root. A file that fails any of these is passed over, as if the walk had not listed it.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
(() => {
  const { root, files, pattern, flags, wholeWord, maxHits, perFile, maxBytes, maxResultBytes, maxLineChars } = workerData;
  let expression;
  try {
    new RegExp(pattern, flags);
    const word = '[A-Za-z0-9_]';
    expression = new RegExp(wholeWord ? '(?<!' + word + ')(?:' + pattern + ')(?!' + word + ')' : pattern, flags);
  } catch {
    parentPort.postMessage({ type: 'invalid' });
    return;
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    parentPort.postMessage({ type: 'done', cut: false });
    return;
  }
  const insideRoot = (real) => {
    const relative = path.relative(realRoot, real);
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const decode = (data) => {
    if (data.length >= 3 && data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF) {
      const body = data.subarray(3);
      return body.indexOf(0) === -1 ? body.toString('utf8') : null;
    }
    if (data.length >= 2 && data[0] === 0xFF && data[1] === 0xFE) return data.subarray(2).toString('utf16le');
    if (data.length >= 2 && data[0] === 0xFE && data[1] === 0xFF) {
      const body = Buffer.from(data.subarray(2));
      return body.subarray(0, body.length - (body.length % 2)).swap16().toString('utf16le');
    }
    return data.indexOf(0) === -1 ? data.toString('utf8') : null;
  };
  const readText = (file) => {
    let fd;
    try {
      fd = fs.openSync(file.absolute, openFlags);
      const stats = fs.fstatSync(fd);
      if (!stats.isFile() || stats.size > maxBytes) return null;
      if (!insideRoot(fs.realpathSync.native(file.absolute))) return null;
      return decode(fs.readFileSync(fd));
    } catch {
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  let total = 0;
  let bytes = 0;
  let cut = false;
  for (const file of files) {
    if (total >= maxHits || cut) break;
    const content = readText(file);
    if (content === null) continue;
    const lines = content.split('\\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const hits = [];
    for (let i = 0; i < lines.length && hits.length < perFile && total + hits.length < maxHits; i++) {
      let text = lines[i].endsWith('\\r') ? lines[i].slice(0, -1) : lines[i];
      const found = expression.exec(text);
      if (!found) continue;
      let matchStart = found.index;
      let matchEnd = found.index + found[0].length;
      if (text.length > maxLineChars) {
        const from = Math.max(0, Math.min(matchStart - 200, text.length - maxLineChars));
        text = text.slice(from, from + maxLineChars);
        matchStart -= from;
        matchEnd = Math.min(matchEnd - from, text.length);
      }
      bytes += Buffer.byteLength(text) + Buffer.byteLength(file.relative) + 64;
      if (bytes > maxResultBytes) { cut = true; break; }
      hits.push({ path: file.relative, line: i + 1, column: found.index + 1, text, matchStart, matchEnd });
    }
    if (hits.length > 0) {
      total += hits.length;
      parentPort.postMessage({ type: 'hits', hits });
    }
  }
  parentPort.postMessage({ type: 'done', cut });
})();
`;

type WorkerMessage = { type: 'invalid' } | { type: 'done'; cut: boolean } | { type: 'hits'; hits: ContentSearchHit[] };

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Searches `files`, in order, for the lines that match `options`, in a worker thread that is terminated after `timeoutMs`. At most
 * `options.maxHits` hits, and {@link CONTENT_SEARCH_MAX_HITS_PER_FILE} per file. A file that cannot be read, is larger than
 * {@link CONTENT_SEARCH_MAX_FILE_BYTES}, holds a NUL byte (a binary file, unless a byte order mark says it is UTF-16 text), or is not
 * inside `root` any more is passed over. `root` is the directory the `relative` paths are relative to.
 */
export function scanFilesForContent(root: string, files: ContentScanFile[], options: ContentSearchOptions, timeoutMs: number): Promise<ContentScanResult> {
  return new Promise((resolve, reject) => {
    const hits: ContentSearchHit[] = [];
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        root,
        files,
        pattern: options.regex ? options.query : escapeForRegExp(options.query),
        flags: options.caseSensitive ? '' : 'i',
        wholeWord: options.wholeWord,
        maxHits: options.maxHits,
        perFile: CONTENT_SEARCH_MAX_HITS_PER_FILE,
        maxBytes: CONTENT_SEARCH_MAX_FILE_BYTES,
        maxResultBytes: CONTENT_SEARCH_MAX_RESULT_BYTES,
        maxLineChars: CONTENT_SEARCH_MAX_LINE_CHARS,
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
    const timer = setTimeout(() => finish({ hits, timedOut: true, invalid: false, cut: false }), Math.max(1, timeoutMs));
    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'hits') hits.push(...message.hits);
      else if (message.type === 'invalid') finish({ hits: [], timedOut: false, invalid: true, cut: false });
      else finish({ hits, timedOut: false, invalid: false, cut: message.cut });
    });
    worker.on('error', (err) => finish(err));
    worker.on('exit', () => finish(new Error('The content search worker exited before it finished')));
  });
}
