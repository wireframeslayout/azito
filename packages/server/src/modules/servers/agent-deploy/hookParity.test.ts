import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The bash hooks (POSIX) and azito-hook.mjs (Windows) must send the same requests. Both are run for real against one HTTP server
// and the bodies are compared as text. The bash hooks need bash + curl, so this runs where those are (not on the Windows runner).
const HOOKS_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'harness', 'hooks');
const NODE_HOOK = path.join(HOOKS_DIR, 'azito-hook.mjs');
const MISAO_PANE = 'p_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

interface Received { path: string; authorization: string | undefined; body: string }

interface Case {
  hook: 'activity' | 'interaction' | 'question' | 'session' | 'notify';
  event?: 'start' | 'stop';
  stdin?: string;
  env?: Record<string, string>;
  /** env-file content; the text is valid for the bash `source` and for the Node reader alike */
  envFile?: (url: string) => string;
  prefix?: string;
  /** nothing is to be sent */
  expectNone?: boolean;
}

let server: http.Server;
let received: Received[];
let baseUrl: string;
let home: string;
let binDir: string;

beforeEach(async () => {
  received = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-hook-parity-'));
  binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir);
  // A stand-in tmux that answers display-message with a fixed identity.
  fs.writeFileSync(path.join(binDir, 'tmux'), '#!/bin/sh\necho "$TEST_TMUX_IDENT"\n', { mode: 0o755 });
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});

function run(file: string, args: string[], stdin: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env }, (err) => (err ? reject(err) : resolve()));
    child.stdin?.end(stdin);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForRequest(expectNone: boolean): Promise<void> {
  if (expectNone) {
    await sleep(600);
    return;
  }
  const deadline = Date.now() + 5000;
  while (received.length < 1 && Date.now() < deadline) await sleep(25);
}

async function exercise(kind: 'bash' | 'node', c: Case): Promise<Received[]> {
  received = [];
  const dotAzito = path.join(home, '.azito');
  fs.rmSync(dotAzito, { recursive: true, force: true });
  if (c.envFile) {
    fs.mkdirSync(dotAzito);
    fs.writeFileSync(path.join(dotAzito, `azitoctl${c.prefix ? `-${c.prefix}` : ''}.env`), c.envFile(baseUrl));
  }
  const env: Record<string, string> = { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: home, TEST_TMUX_IDENT: 'main|2|work|1', ...c.env };
  const stdin = c.stdin ?? '';
  const eventArgs = c.event ? [c.event] : [];
  if (kind === 'bash') {
    await run('bash', [path.join(HOOKS_DIR, `azito-${c.hook}.sh`), ...eventArgs], stdin, c.prefix ? { ...env, AZITO_PREFIX: c.prefix } : env);
  } else {
    await run(process.execPath, [NODE_HOOK, c.hook, ...eventArgs, ...(c.prefix ? ['--prefix', c.prefix] : [])], stdin, env);
  }
  await waitForRequest(c.expectNone === true);
  return received;
}

async function expectSame(c: Case): Promise<Received[]> {
  const fromBash = await exercise('bash', c);
  const fromNode = await exercise('node', c);
  expect(fromNode).toEqual(fromBash);
  expect(fromBash.length).toBe(c.expectNone ? 0 : 1);
  return fromNode;
}

const fullEnv = (): Record<string, string> => ({ AZITO_URL: baseUrl, AZITO_WEBHOOK_TOKEN: 'tok-env', AZITO_SERVER_NAME: 'srv one' });
const sessionStdin = JSON.stringify({ session_id: SESSION, hook_event_name: 'UserPromptSubmit' });
const fileWith = (token: string, name: string) => (url: string): string => `AZITO_URL="${url}"\nAZITO_WEBHOOK_TOKEN="${token}"\nAZITO_SERVER_NAME="${name}"\n`;

describeOnPosix('azito-hook.mjs sends what the bash hooks send', () => {
  it('activity start from a misao pane, with the session id', async () => {
    const [req] = await expectSame({ hook: 'activity', event: 'start', stdin: sessionStdin, env: { ...fullEnv(), MISAO_PANE_ID: MISAO_PANE } });
    expect(req.path).toBe('/api/webhooks/agent-activity');
    expect(req.authorization).toBe('Bearer tok-env');
    expect(JSON.parse(req.body)).toEqual({ serverName: 'srv one', misaoPaneId: MISAO_PANE, event: 'start', sessionId: SESSION });
  });

  it('activity stop from a tmux pane', async () => {
    const [req] = await expectSame({ hook: 'activity', event: 'stop', stdin: '{}', env: { ...fullEnv(), TMUX_PANE: '%3' } });
    expect(JSON.parse(req.body)).toEqual({ serverName: 'srv one', sessionName: 'main', windowIndex: 2, windowName: 'work', paneIndex: 1, event: 'stop', muxPaneRef: '%3' });
  });

  it('a tmux pane wins over a misao pane id', async () => {
    await expectSame({ hook: 'activity', event: 'start', stdin: '{}', env: { ...fullEnv(), TMUX_PANE: '%3', MISAO_PANE_ID: MISAO_PANE } });
  });

  it('takes the whole profile from the env file of the prefix, and drops a partial environment', async () => {
    const [req] = await expectSame({
      hook: 'activity', event: 'start', stdin: sessionStdin, prefix: 'prod',
      env: { AZITO_URL: 'http://ambient.invalid:1', MISAO_PANE_ID: MISAO_PANE },
      envFile: fileWith('tok-file', 'file-server'),
    });
    expect(req.authorization).toBe('Bearer tok-file');
    expect(JSON.parse(req.body).serverName).toBe('file-server');
  });

  it('sends nothing without a token, a server name or an identifiable pane', async () => {
    await expectSame({ hook: 'activity', event: 'start', stdin: '{}', env: { MISAO_PANE_ID: MISAO_PANE }, expectNone: true });
    await expectSame({ hook: 'activity', event: 'start', stdin: '{}', env: fullEnv(), expectNone: true });
    await expectSame({ hook: 'activity', event: 'start', stdin: '{}', env: { ...fullEnv(), MISAO_PANE_ID: 'p_lowercase' }, expectNone: true });
    await expectSame({ hook: 'activity', event: 'start', stdin: '{}', env: { ...fullEnv(), TMUX_PANE: '%3', TEST_TMUX_IDENT: 'main|x|work|1' }, expectNone: true });
    await expectSame({ hook: 'activity', event: 'start', stdin: '{}', env: { ...fullEnv(), AZITO_SERVER_NAME: 'bad"name', MISAO_PANE_ID: MISAO_PANE }, expectNone: true });
  }, 30_000);

  it('leaves an invalid session id out of an activity event', async () => {
    const [req] = await expectSame({ hook: 'activity', event: 'stop', stdin: '{"session_id":"not-a-uuid"}', env: { ...fullEnv(), MISAO_PANE_ID: MISAO_PANE } });
    expect(JSON.parse(req.body)).not.toHaveProperty('sessionId');
  });

  it('session sends event "session" and needs a valid session id', async () => {
    const [req] = await expectSame({ hook: 'session', stdin: JSON.stringify({ session_id: SESSION }), env: { ...fullEnv(), MISAO_PANE_ID: MISAO_PANE } });
    expect(JSON.parse(req.body)).toEqual({ serverName: 'srv one', misaoPaneId: MISAO_PANE, event: 'session', sessionId: SESSION });
    await expectSame({ hook: 'session', stdin: '{"session_id":"x"}', env: { ...fullEnv(), MISAO_PANE_ID: MISAO_PANE }, expectNone: true });
  });

  it('interaction opens a pending answer, except for notifications that are not one', async () => {
    const [req] = await expectSame({ hook: 'interaction', stdin: '{"notification_type":"idle_prompt"}', env: { ...fullEnv(), TMUX_PANE: '%3' } });
    expect(req.path).toBe('/api/webhooks/agent-interaction');
    expect(JSON.parse(req.body).event).toBe('open');
    await expectSame({ hook: 'interaction', stdin: '{"notification_type":"auth_success"}', env: { ...fullEnv(), TMUX_PANE: '%3' }, expectNone: true });
    await expectSame({ hook: 'interaction', stdin: 'not json at all', env: { ...fullEnv(), MISAO_PANE_ID: MISAO_PANE } });
  });

  const question = (q: unknown): string => JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: { questions: [q] } });

  it('question carries the question card, with newlines, quotes and non-ASCII intact', async () => {
    const [req] = await expectSame({
      hook: 'question',
      stdin: question({ question: 'どれにしますか?\n"二行目"', header: 'H', multiSelect: true, options: [{ label: 'A', description: 'a desc' }, { label: 'B' }] }),
      env: { ...fullEnv(), MISAO_PANE_ID: MISAO_PANE },
    });
    const content = JSON.parse(req.body).content;
    expect(content.toolName).toBe('AskUserQuestion');
    expect(content.questions[0].question).toBe('どれにしますか?\n"二行目"');
  });

  it('question: tmux pane, and a request that is not an AskUserQuestion sends nothing', async () => {
    await expectSame({ hook: 'question', stdin: question({ question: 'q', options: [] }), env: { ...fullEnv(), TMUX_PANE: '%3' } });
    await expectSame({ hook: 'question', stdin: JSON.stringify({ tool_name: 'Bash' }), env: { ...fullEnv(), TMUX_PANE: '%3' }, expectNone: true });
  });

  it('question: a card over 32 KB is dropped and the plain open event is sent', async () => {
    const [req] = await expectSame({ hook: 'question', stdin: question({ question: 'x'.repeat(40000), options: [] }), env: { ...fullEnv(), MISAO_PANE_ID: MISAO_PANE } });
    expect(JSON.parse(req.body)).toEqual({ serverName: 'srv one', misaoPaneId: MISAO_PANE, event: 'open' });
  });

  it('notify (Stop) posts agent-done with the env file values', async () => {
    const [req] = await expectSame({ hook: 'notify', envFile: fileWith('tok-file', 'ignored'), env: {} });
    expect(req.path).toBe('/api/webhooks/agent-done');
    expect(req.authorization).toBe('Bearer tok-file');
    expect(JSON.parse(req.body)).toEqual({ server: os.hostname(), summary: 'Agent task completed' });
  });
});
