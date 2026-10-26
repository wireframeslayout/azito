#!/usr/bin/env node
// azitoctl (Node version, used on Windows; POSIX keeps the bash `azitoctl`).
//
// What a coding agent runs to report back to the AZITO hub, and to write what the hub reads, without any shell syntax (a heredoc,
// `echo >>`, a redirect) — the agent's shell on Windows is Git Bash or PowerShell, whose quoting and encodings differ.
//
//   node azitoctl.mjs complete  --turn <token> [--summary <text>] [--output-file <path>] [--test-failed]
//   node azitoctl.mjs questions --turn <token> (<questions_json> | --json-file <path>)
//   node azitoctl.mjs fail      --turn <token> --reason <text>
//   node azitoctl.mjs progress  --turn <token>
//   node azitoctl.mjs signal    --file <signal file> --marker <marker> [--json-file <path>]
//   node azitoctl.mjs output    --file <path>        (the content comes on stdin)
//
// The first four send the same request bodies to the same webhook as the bash `azitoctl` (agentSignalRoutes); the body is
// built in one place (`buildBody`) and `azitoctl.test.ts` runs both versions against one HTTP server and compares them.
// `signal` appends one line to the signal file the hub watches (the file-signal mode of a task): `<marker>` for a completion,
// `<marker>: <one-line JSON>` for questions. `output` writes the phase's output file as UTF-8 without a BOM.
//
// Like the bash version, a turn signal is required data with no fallback: a missing hub URL is a hard error (exit 3). Exit codes:
// 0 sent / written, 1 the hub could not be reached or refused, 2 a bad command line or file, 3 no configuration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from '../hooks/azito-hook.mjs';

const MAX_OUTPUT_BYTES = 262144;
const REQUEST_TIMEOUT_MS = 15000;
const SEND_ATTEMPTS = 4;
const RETRY_DELAY_MS = 1000;
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const SUBCOMMANDS = new Set(['complete', 'questions', 'fail', 'progress', 'signal', 'output']);
const MARKER = /^[A-Za-z0-9_]+$/;

const USAGE = `Usage:
  azitoctl complete  --turn <token> [--summary <text>] [--output-file <path>] [--test-failed]
  azitoctl questions --turn <token> (<questions_json> | --json-file <path>)
  azitoctl fail      --turn <token> --reason <text>
  azitoctl progress  --turn <token>
  azitoctl signal    --file <signal file> --marker <marker> [--json-file <path>]
  azitoctl output    --file <path>   (content on stdin)`;

/** A failure with the exit code to end with and the message for stderr. */
export class CliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

const usageError = (message) => new CliError(message ? `azitoctl: ${message}\n${USAGE}` : USAGE, 2);

/** Splits the command line into the subcommand, its options and positional arguments. */
export function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!SUBCOMMANDS.has(command)) throw usageError();
  const options = { turn: '', summary: '', outputFile: '', testFailed: false, reason: '', file: '', marker: '', jsonFile: '' };
  const positional = [];
  const valueOptions = { '--turn': 'turn', '--summary': 'summary', '--output-file': 'outputFile', '--reason': 'reason', '--file': 'file', '--marker': 'marker', '--json-file': 'jsonFile' };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (arg === '--test-failed') {
      options.testFailed = true;
    } else if (Object.hasOwn(valueOptions, arg)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw usageError(`option ${arg} requires a value`);
      options[valueOptions[arg]] = value;
      i++;
    } else if (arg.startsWith('-')) {
      throw usageError(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { command, options, positional };
}

/** Checks the command's arguments (before any file is read or request sent), as the bash version does. */
export function validateCli({ command, options, positional }) {
  if (command === 'signal') {
    if (!options.file || !options.marker) throw usageError('signal needs --file and --marker');
    if (!MARKER.test(options.marker)) throw usageError(`invalid marker: ${options.marker}`);
    return;
  }
  if (command === 'output') {
    if (!options.file) throw usageError('output needs --file');
    return;
  }
  if (!options.turn) throw usageError('--turn is required');
  if (command === 'questions') {
    const given = (positional.length === 1 ? 1 : 0) + (options.jsonFile ? 1 : 0);
    if (given !== 1 || positional.length > 1) throw usageError('questions needs the JSON as one argument or --json-file');
  }
  if (command === 'fail' && !options.reason) throw usageError('fail needs --reason');
}

/**
 * Hub URL and webhook token: the environment when it holds both; otherwise the whole set from the env file the prefix selects
 * (azitoctl[-<prefix>].env, the same name as envFiles.mjs azitoctlEnvName and the bash azitoctl, and the same rule as the hooks: the
 * file's token is never sent to a URL that is not the file's). Only when that file does not exist is the environment's URL used as is;
 * a prefix whose file is missing never falls back to the unprefixed file (another hub's). The token is optional.
 */
export function resolveConfig({ env, homeDir, readFile }) {
  let url = env.AZITO_URL ?? '';
  let token = env.AZITO_WEBHOOK_TOKEN ?? '';
  const prefix = env.AZITO_PREFIX ?? '';
  const envFile = path.join(homeDir, '.azito', `azitoctl${prefix ? `-${prefix}` : ''}.env`);
  if (!url || !token) {
    let file = {};
    let fileExists = false;
    try {
      file = parseEnvFile(readFile(envFile));
      fileExists = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw new CliError(`azitoctl: cannot read the env file: ${err.message}`, 3);
      if (prefix && !url) throw new CliError(`azitoctl: AZITO_PREFIX=${prefix} but ${envFile} does not exist (not falling back to the unprefixed azitoctl.env of another hub)`, 3);
    }
    if (fileExists) {
      url = file.AZITO_URL ?? '';
      token = file.AZITO_WEBHOOK_TOKEN ?? '';
    }
  }
  if (!url) throw new CliError(`azitoctl: AZITO_URL not set (env or ${envFile})`, 3);
  return { url, token };
}

function readOutputFile(file) {
  let data;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(MAX_OUTPUT_BYTES);
      const read = fs.readSync(fd, buffer, 0, MAX_OUTPUT_BYTES, 0);
      data = buffer.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (err?.code === 'ENOENT') throw new CliError(`azitoctl: output file not found: ${file}`, 2);
    throw new CliError(`azitoctl: cannot read ${file}: ${err.message}`, 2);
  }
  // The first 256 KB of bytes, as `head -c` cuts them: a character cut in the middle becomes U+FFFD (Buffer's decoder replaces it).
  // A BOM (PowerShell 5.1's `Set-Content -Encoding utf8` writes one) is not part of the text.
  return data.toString('utf8').replace(/^\uFEFF/, '');
}

function parseQuestions(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('azitoctl: invalid questions JSON', 2);
  }
}

function readJsonFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (err) {
    throw new CliError(`azitoctl: cannot read ${file}: ${err.message}`, 2);
  }
}

/** The request body for a turn signal (complete / questions / fail / progress): the same fields, in the same order, as the bash version. */
export function buildBody({ command, options, positional }) {
  const body = { turnToken: options.turn, type: command };
  if (command === 'complete') {
    if (options.summary) body.summary = options.summary;
    if (options.outputFile) body.output = readOutputFile(options.outputFile);
    if (options.testFailed) body.testFailed = true;
  } else if (command === 'questions') {
    body.questions = parseQuestions(options.jsonFile ? readJsonFile(options.jsonFile) : positional[0]);
  } else if (command === 'fail') {
    body.reason = options.reason;
  }
  return body;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** POSTs the body, retrying a connection failure and a transient status like `curl --retry 3 --retry-connrefused`. Returns the HTTP status. */
export async function sendSignal({ url, token }, body, { fetchImpl = fetch, retryDelayMs = RETRY_DELAY_MS } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  // The token authenticates the signal channel when present; the turn token alone is accepted by the hub otherwise.
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload = JSON.stringify(body);
  let failure = 'no attempt was made';
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      const res = await fetchImpl(`${url}/api/agent-signals`, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) return res.status;
      failure = `HTTP ${res.status}`;
      if (!RETRY_STATUSES.has(res.status)) break;
    } catch (err) {
      failure = err instanceof Error ? (err.cause?.code ?? err.message) : String(err);
    }
    if (attempt < SEND_ATTEMPTS) await sleep(retryDelayMs * attempt);
  }
  throw new CliError(`azitoctl: failed to send the signal (${failure})`, 1);
}

/** The one line a `signal` appends: the marker, and for questions `: <the JSON on one line>`. */
export function signalLine({ options }) {
  if (!options.jsonFile) return options.marker;
  return `${options.marker}: ${JSON.stringify(parseQuestions(readJsonFile(options.jsonFile)))}`;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

function writeFileOrFail(file, data) {
  try {
    fs.writeFileSync(file, data);
  } catch (err) {
    throw new CliError(`azitoctl: cannot write ${file}: ${err.message}`, 2);
  }
}

/** Runs the command line; resolves to the line to print on stdout (or null). A failure is a {@link CliError}. */
export async function run(argv, { env = process.env, homeDir = os.homedir(), readFile = (file) => fs.readFileSync(file, 'utf8'), readInput = readStdin, fetchImpl = fetch, retryDelayMs = RETRY_DELAY_MS } = {}) {
  const parsed = parseCli(argv);
  validateCli(parsed);
  if (parsed.command === 'output') {
    // Bytes in, bytes out: the content is already UTF-8, and a decode and encode on the way would only be able to damage it.
    writeFileOrFail(parsed.options.file, await readInput());
    return null;
  }
  if (parsed.command === 'signal') {
    const line = signalLine(parsed);
    try {
      fs.appendFileSync(parsed.options.file, `${line}\n`);
    } catch (err) {
      throw new CliError(`azitoctl: cannot append to ${parsed.options.file}: ${err.message}`, 2);
    }
    return null;
  }
  const config = resolveConfig({ env, homeDir, readFile });
  const status = await sendSignal(config, buildBody(parsed), { fetchImpl, retryDelayMs });
  return String(status);
}

// Compared by real path: started through a link or a junction, the paths differ and a plain comparison would run nothing and exit 0.
const isMain = process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  run(process.argv.slice(2)).then(
    (line) => { if (line !== null) process.stdout.write(`${line}\n`); },
    (err) => {
      if (err instanceof CliError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = err.exitCode;
      } else {
        process.stderr.write(`azitoctl: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    },
  );
}
