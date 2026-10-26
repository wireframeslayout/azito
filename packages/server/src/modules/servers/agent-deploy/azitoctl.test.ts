import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// azitoctl.mjs (Windows) is run for real, as a program, against one HTTP server and in a temp home; the bash azitoctl (POSIX) is run
// against the same server and the two bodies are compared as text (it needs bash + curl, so that part is not run on the Windows runner).
const BIN_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'harness', 'bin');
const NODE_CTL = path.join(BIN_DIR, 'azitoctl.mjs');
const BASH_CTL = path.join(BIN_DIR, 'azitoctl');
const TURN = 'azt.turn.7.0123456789abcdef0123456789abcdef';

interface Received { path: string; method: string | undefined; authorization: string | undefined; body: string }
interface Ran { code: number; stdout: string; stderr: string }

let server: http.Server;
let received: Received[];
let baseUrl: string;
let home: string;
let status: number;

beforeEach(async () => {
  received = [];
  status = 200;
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', method: req.method, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      res.statusCode = status;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-ctl-'));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});

function run(file: string, args: string[], env: Record<string, string>, stdin = ''): Promise<Ran> {
  return new Promise((resolve) => {
    const base: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home };
    if (process.env.SystemRoot) base.SystemRoot = process.env.SystemRoot;
    const child = execFile(file, args, { env: { ...base, ...env }, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
    child.stdin?.end(stdin);
  });
}

const node = (args: string[], env: Record<string, string> = {}, stdin = ''): Promise<Ran> => run(process.execPath, [NODE_CTL, ...args], env, stdin);
const hub = (): Record<string, string> => ({ AZITO_URL: baseUrl, AZITO_WEBHOOK_TOKEN: 'tok-env' });
const write = (name: string, content: string): string => {
  const file = path.join(home, name);
  fs.writeFileSync(file, content);
  return file;
};

describe('azitoctl.mjs — turn signals', () => {
  it('complete: sends the output file (UTF-8, quotes and newlines intact) with the webhook token', async () => {
    const out = write('out.md', '計画 "quoted" \\ back\nline 2\n\nAZITO_PHASE_SUMMARY: {"phase":"planning"}\n');

    const ran = await node(['complete', '--turn', TURN, '--summary', 'done it', '--output-file', out, '--test-failed'], hub());

    expect(ran).toMatchObject({ code: 0, stdout: '200\n' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ path: '/api/agent-signals', method: 'POST', authorization: 'Bearer tok-env' });
    expect(JSON.parse(received[0].body)).toEqual({
      turnToken: TURN, type: 'complete', summary: 'done it', testFailed: true,
      output: '計画 "quoted" \\ back\nline 2\n\nAZITO_PHASE_SUMMARY: {"phase":"planning"}\n',
    });
  });

  it('complete: cuts the output at 256 KiB of bytes', async () => {
    const out = write('big.md', 'a'.repeat(300_000));
    await node(['complete', '--turn', TURN, '--output-file', out], hub());
    expect(JSON.parse(received[0].body).output).toHaveLength(262144);
  });

  it('questions: the JSON as an argument, and from a file', async () => {
    const questions = [{ text: '日本語?', type: 'select', options: ['A', 'B'] }];
    await node(['questions', '--turn', TURN, JSON.stringify(questions)], hub());
    await node(['questions', '--turn', TURN, '--json-file', write('q.json', `﻿${JSON.stringify(questions, null, 2)}`)], hub());
    expect(received.map((r) => JSON.parse(r.body))).toEqual([
      { turnToken: TURN, type: 'questions', questions },
      { turnToken: TURN, type: 'questions', questions },
    ]);
  });

  it('fail and progress', async () => {
    await node(['fail', '--turn', TURN, '--reason', 'it broke'], hub());
    await node(['progress', '--turn', TURN], hub());
    expect(received.map((r) => JSON.parse(r.body))).toEqual([
      { turnToken: TURN, type: 'fail', reason: 'it broke' },
      { turnToken: TURN, type: 'progress' },
    ]);
  });

  it('reads the hub from the env file the AZITO_PREFIX selects, and sends no Authorization without a token', async () => {
    fs.mkdirSync(path.join(home, '.azito'));
    fs.writeFileSync(path.join(home, '.azito', 'azitoctl-dev.env'), `AZITO_URL=${JSON.stringify(baseUrl)}\n`);

    const ran = await node(['progress', '--turn', TURN], { AZITO_PREFIX: 'dev' });

    expect(ran.code).toBe(0);
    expect(received[0].authorization).toBeUndefined();
  });

  it('exits 3 with no hub URL, 2 for bad arguments or JSON, and 1 when the hub refuses', async () => {
    expect((await node(['progress', '--turn', TURN])).code).toBe(3);
    expect((await node(['progress'], hub())).code).toBe(2);
    expect((await node(['nonsense'], hub())).code).toBe(2);
    expect((await node(['questions', '--turn', TURN, '{not json'], hub())).code).toBe(2);
    expect((await node(['complete', '--turn', TURN, '--output-file', path.join(home, 'missing.md')], hub())).code).toBe(2);
    expect(received).toHaveLength(0);
    status = 401;
    const refused = await node(['progress', '--turn', TURN], hub());
    expect(refused.code).toBe(1);
    expect(received).toHaveLength(1); // 401 is not retried
  });
});

describe('azitoctl.mjs — sendSignal', () => {
  it('retries a connection failure and a transient status, then gives up with exit code 1', async () => {
    const { sendSignal, CliError } = await import(/* @vite-ignore */ pathToFileURL(NODE_CTL).href);
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    await expect(sendSignal({ url: 'http://hub', token: '' }, { type: 'progress' }, { fetchImpl, retryDelayMs: 0 })).resolves.toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const always = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const failure = await sendSignal({ url: 'http://hub', token: '' }, { type: 'progress' }, { fetchImpl: always, retryDelayMs: 0 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({ exitCode: 1 });
    expect(always).toHaveBeenCalledTimes(4);
  });
});

describe('azitoctl.mjs — the task files', () => {
  it('signal: appends the marker, and the questions on one line', async () => {
    const signalFile = path.join(home, 'sig.log');
    fs.writeFileSync(signalFile, 'earlier line\n');
    const json = write('q.json', '[\n  {"text":"どちら?","type":"select","options":["A","B"]}\n]\n');

    expect((await node(['signal', '--file', signalFile, '--marker', 'AZITO_QUESTIONS_7_abc123', '--json-file', json])).code).toBe(0);
    expect((await node(['signal', '--file', signalFile, '--marker', 'AZITO_DONE_7_abc123'])).code).toBe(0);

    expect(fs.readFileSync(signalFile, 'utf8')).toBe(
      'earlier line\nAZITO_QUESTIONS_7_abc123: [{"text":"どちら?","type":"select","options":["A","B"]}]\nAZITO_DONE_7_abc123\n',
    );
  });

  it('signal: refuses a marker with other characters and questions that are not JSON, writing nothing', async () => {
    const signalFile = path.join(home, 'sig.log');
    expect((await node(['signal', '--file', signalFile, '--marker', 'AZITO DONE; rm -rf'])).code).toBe(2);
    expect((await node(['signal', '--file', signalFile, '--marker', 'AZITO_QUESTIONS_7_a', '--json-file', write('bad.json', '[{')])).code).toBe(2);
    expect(fs.existsSync(signalFile)).toBe(false);
  });

  it('output: writes stdin as UTF-8, byte for byte', async () => {
    const target = path.join(home, 'azito-output-7-abc.md');
    const content = '# 計画\r\n\r\n- "quoted" $(not run) `ticks`\n\nAZITO_PHASE_SUMMARY: {"phase":"planning"}\n';

    const ran = await node(['output', '--file', target], {}, content);

    expect(ran.code).toBe(0);
    expect(fs.readFileSync(target)).toEqual(Buffer.from(content, 'utf8'));
  });
});

describe.skipIf(process.platform === 'win32')('azitoctl.mjs sends what the bash azitoctl sends', { timeout: 30_000 }, () => {
  async function sameBody(args: string[], env: Record<string, string> = hub()): Promise<Received> {
    received = [];
    const fromBash = await run('bash', [BASH_CTL, ...args], env);
    const bashRequest = received.slice();
    received = [];
    const fromNode = await node(args, env);
    expect(fromNode.code).toBe(fromBash.code);
    expect(fromNode.stdout).toBe(fromBash.stdout);
    // The values and the order of the fields are compared, not the text: python's json.dumps writes non-ASCII as \uXXXX escapes.
    const shape = (r: Received[]) => r.map((x) => ({ ...x, body: JSON.parse(x.body) as unknown, fields: Object.keys(JSON.parse(x.body) as object) }));
    expect(shape(received)).toEqual(shape(bashRequest));
    expect(received).toHaveLength(1);
    return received[0];
  }

  it('complete with an output file, a summary and test-failed', async () => {
    const out = write('out.md', '計画 "quoted" \\ back\nline 2\ttab\n\nAZITO_PHASE_SUMMARY: {"phase":"planning"}\n');
    const request = await sameBody(['complete', '--turn', TURN, '--summary', 'a "b" c', '--output-file', out, '--test-failed']);
    expect(request.authorization).toBe('Bearer tok-env');
  });

  it('questions, fail, progress, and complete with nothing else', async () => {
    await sameBody(['questions', '--turn', TURN, '[{"text":"日本語 \\"q\\"","type":"text"}]']);
    await sameBody(['fail', '--turn', TURN, '--reason', 'line1\nline2']);
    await sameBody(['progress', '--turn', TURN]);
    await sameBody(['complete', '--turn', TURN]);
  });

  it('the same request without a webhook token', async () => {
    await sameBody(['progress', '--turn', TURN], { AZITO_URL: baseUrl });
  });
});

// #528: which azitoctl[-<prefix>].env is read. Both implementations follow the same rules: AZITO_PREFIX selects the file (never the
// unprefixed one of another hub), a complete set in the pane's environment is used without reading the file, otherwise the file's whole set is used.
describe('azitoctl env file selection (bash and node)', { timeout: 30_000 }, () => {
  const DEAD_HUB = 'http://127.0.0.1:9'; // the "other hub": anything sent here never arrives, and the test would see no request
  const impls: Array<[string, (args: string[], env: Record<string, string>) => Promise<Ran>]> = [
    ['bash', (args, env) => run('bash', [BASH_CTL, ...args], env)],
    ['node', (args, env) => node(args, env)],
  ];
  const envFile = (name: string, url: string, token: string): void => {
    fs.mkdirSync(path.join(home, '.azito'), { recursive: true });
    fs.writeFileSync(path.join(home, '.azito', name), `AZITO_URL=${JSON.stringify(url)}\nAZITO_WEBHOOK_TOKEN=${JSON.stringify(token)}\n`);
  };
  const args = ['progress', '--turn', TURN];

  describe.each(impls)('%s', (name, ctl) => {
    // the bash script needs bash + curl; the node one (azitoctl.mjs) is what Windows runs, so it is tested there too
    if (name === 'bash' && process.platform === 'win32') {
      it.skip('is not run on Windows', () => {});
      return;
    }

    it('AZITO_PREFIX selects azitoctl-<prefix>.env even when the unprefixed file of another hub exists', async () => {
      envFile('azitoctl.env', DEAD_HUB, 'tok-other');
      envFile('azitoctl-dev.env', baseUrl, 'tok-dev');

      const ran = await ctl(args, { AZITO_PREFIX: 'dev' });

      expect(ran.code).toBe(0);
      expect(received).toHaveLength(1);
      expect(received[0].authorization).toBe('Bearer tok-dev');
    });

    it('without a prefix, reads the unprefixed azitoctl.env and leaves the prefixed one alone', async () => {
      envFile('azitoctl.env', baseUrl, 'tok-plain');
      envFile('azitoctl-dev.env', DEAD_HUB, 'tok-dev');

      expect((await ctl(args, {})).code).toBe(0);
      expect((await ctl(args, { AZITO_PREFIX: '' })).code).toBe(0);
      expect(received.map((r) => r.authorization)).toEqual(['Bearer tok-plain', 'Bearer tok-plain']);
    });

    it('a complete set in the pane environment is used as is and the env file is not read', async () => {
      envFile('azitoctl-dev.env', DEAD_HUB, 'tok-file');

      const ran = await ctl(args, { AZITO_PREFIX: 'dev', AZITO_URL: baseUrl, AZITO_WEBHOOK_TOKEN: 'tok-pane' });

      expect(ran.code).toBe(0);
      expect(received).toHaveLength(1);
      expect(received[0].authorization).toBe('Bearer tok-pane');
    });

    it('a URL alone in the pane environment is not used: the whole set comes from the file, so the file token never goes to the pane URL', async () => {
      envFile('azitoctl-dev.env', baseUrl, 'tok-file');

      const ran = await ctl(args, { AZITO_PREFIX: 'dev', AZITO_URL: DEAD_HUB });

      expect(ran.code).toBe(0);
      expect(received).toHaveLength(1); // it reached the file's hub, not the pane's URL
      expect(received[0].authorization).toBe('Bearer tok-file');
    });

    it('a token alone in the pane environment is not used either: the whole set comes from the file', async () => {
      envFile('azitoctl-dev.env', baseUrl, 'tok-file');

      const ran = await ctl(args, { AZITO_PREFIX: 'dev', AZITO_WEBHOOK_TOKEN: 'tok-pane' });

      expect(ran.code).toBe(0);
      expect(received[0].authorization).toBe('Bearer tok-file');
    });

    it('a prefix whose env file is missing is an error that names it, not a fallback to the unprefixed file', async () => {
      envFile('azitoctl.env', baseUrl, 'tok-other');

      const ran = await ctl(args, { AZITO_PREFIX: 'dev' });

      expect(ran.code).toBe(3);
      expect(ran.stderr).toContain('azitoctl-dev.env');
      expect(received).toHaveLength(0);
    });

    it('a prefix whose env file is missing still sends when the pane gave the URL (no token is sent, nothing is taken from another file)', async () => {
      envFile('azitoctl.env', DEAD_HUB, 'tok-other');

      const ran = await ctl(args, { AZITO_PREFIX: 'dev', AZITO_URL: baseUrl });

      expect(ran.code).toBe(0);
      expect(received).toHaveLength(1);
      expect(received[0].authorization).toBeUndefined();
    });
  });
});
