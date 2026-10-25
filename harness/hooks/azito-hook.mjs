#!/usr/bin/env node
// AZITO hook for Claude Code (Node version, used on Windows; POSIX keeps the bash hooks).
//
//   node azito-hook.mjs <activity start|activity stop|interaction|question|session|notify> [--prefix <name>]
//
// One entry point for the five bash hooks (azito-activity.sh / azito-interaction.sh / azito-question.sh /
// azito-session.sh / azito-notify.sh). It sends the same request bodies to the same webhooks: the rules (single destination
// profile, misaoPaneId, tmux identity, which events are dropped) are written the same way, and
// packages/server/src/modules/servers/agent-deploy/hookParity.test.ts runs both versions against one HTTP server and compares
// the bodies. Change a rule in both places.
//
// Differences from the bash hooks, on purpose:
//  - the profile prefix is an argument (`--prefix`), not an environment variable put in front of the command;
//  - the env file is read in the Windows form (see parseEnvFile), not the `printf %q` form of setup.sh;
//  - the request is sent by a detached copy of this script (`--deliver`), fed over stdin, so the hook returns at once
//    (the bash hooks background curl the same way) and the token is never in an argv.
//
// A hook must never disturb Claude Code: every failure ends quietly with exit 0 and nothing on stdout (a PermissionRequest
// hook's stdout would steer the permission decision).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_URL = 'http://localhost:3001';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MISAO_PANE_ID = /^p_[0-9A-Z]{26}$/;
const TMUX_FORMAT = '#{?session_grouped,#{session_group},#{session_name}}|#{window_index}|#{window_name}|#{pane_index}';
const MAX_QUESTION_PAYLOAD_CHARS = 32768;
const DELIVER_TIMEOUT_MS = 3000;
const NOTIFY_TIMEOUT_MS = 5000;
const TMUX_TIMEOUT_MS = 3000;
// notification_type values that are not "waiting for an answer" (see azito-interaction.sh).
const IGNORED_NOTIFICATION_TYPES = new Set(['auth_success', 'agent_completed', 'elicitation_complete', 'elicitation_response']);

/** `--prefix <p>` / `--prefix=<p>` and the positional kind / event. Returns null for a command line that is not ours. */
export function parseArgs(argv) {
  const positional = [];
  let prefix = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--prefix') {
      prefix = argv[++i] ?? '';
    } else if (arg.startsWith('--prefix=')) {
      prefix = arg.slice('--prefix='.length);
    } else {
      positional.push(arg);
    }
  }
  const [kind, event] = positional;
  if (!['activity', 'interaction', 'question', 'session', 'notify'].includes(kind)) return null;
  return { kind, event: event ?? '', prefix };
}

/**
 * The Windows form of an azitoctl*.env file: one `KEY=VALUE` per line, the value a JSON string (`KEY="a b"`) written by
 * setup.mjs. A bare value (no quote, no backslash, no `$`) and a single-quoted one (no escapes) are read too. A value in any
 * other form (the `\ ` and `$'..'` of the bash `%q` form) is not guessed at: that key is left out, so the profile is incomplete
 * and nothing is sent.
 */
export function parseEnvFile(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(rawLine);
    if (!m) continue;
    const raw = m[2];
    if (raw.startsWith('"')) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') values[m[1]] = parsed;
      } catch { /* not a JSON string: left out */ }
    } else if (/^'[^']*'$/.test(raw)) {
      values[m[1]] = raw.slice(1, -1);
    } else if (/^[^\s"'\\$`]*$/.test(raw)) {
      values[m[1]] = raw;
    }
  }
  return values;
}

function envFilePath(homeDir, prefix) {
  return path.join(homeDir, '.azito', `azitoctl${prefix ? `-${prefix}` : ''}.env`);
}

function readEnvFile(homeDir, prefix, readFile) {
  try {
    return parseEnvFile(readFile(envFilePath(homeDir, prefix)));
  } catch {
    return {};
  }
}

/**
 * URL / token / server name are one profile, never merged per variable (see azito-activity.sh): all three in the environment
 * are used as they are, otherwise the whole set comes from the env file the prefix selects.
 */
export function resolveProfile({ env, homeDir, prefix, readFile }) {
  let url = env.AZITO_URL ?? '';
  let token = env.AZITO_WEBHOOK_TOKEN ?? '';
  let serverName = env.AZITO_SERVER_NAME ?? '';
  if (!(url && token && serverName)) {
    const file = readEnvFile(homeDir, prefix, readFile);
    url = file.AZITO_URL ?? '';
    token = file.AZITO_WEBHOOK_TOKEN ?? '';
    serverName = file.AZITO_SERVER_NAME ?? '';
  }
  return { url: url || DEFAULT_URL, token, serverName };
}

/** The stop hook for agent-done (azito-notify.sh): the env file's values win over the environment, there is no all-or-nothing rule. */
export function resolveNotifyProfile({ env, homeDir, prefix, readFile }) {
  const file = readEnvFile(homeDir, prefix, readFile);
  const url = file.AZITO_URL ?? env.AZITO_URL ?? '';
  const token = file.AZITO_WEBHOOK_TOKEN ?? env.AZITO_WEBHOOK_TOKEN ?? '';
  return { url: url || DEFAULT_URL, token };
}

/** First `"field": "value"` in the raw text, like the `grep -o` of the bash hooks (no JSON parsing, so a malformed body still yields). */
export function extractStringField(stdinText, field) {
  const m = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`).exec(stdinText);
  return m ? m[1] : '';
}

const hasJsonSpecial = (value) => value.includes('"') || value.includes('\\');

/** Asks tmux who a pane is. Resolves to the raw `session|window|name|pane` line, or null. */
export function askTmux(tmuxPane) {
  return new Promise((resolve) => {
    execFile('tmux', ['display-message', '-p', '-t', tmuxPane, TMUX_FORMAT], { timeout: TMUX_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.replace(/\n+$/, ''));
    });
  });
}

/**
 * Who the pane is for the hub: `{ misaoPaneId }` for a misao pane (no $TMUX_PANE), or the tmux session / window / pane fields.
 * Null when the pane cannot be identified (the hook then sends nothing).
 */
export async function resolveIdentity({ env, serverName, tmux }) {
  const tmuxPane = env.TMUX_PANE ?? '';
  if (!tmuxPane && MISAO_PANE_ID.test(env.MISAO_PANE_ID ?? '')) {
    if (hasJsonSpecial(serverName)) return null;
    return { misaoPaneId: env.MISAO_PANE_ID };
  }
  if (!tmuxPane) return null;
  const ident = await tmux(tmuxPane);
  if (!ident) return null;
  const parts = ident.split('|');
  const [sessionName, windowIndex, windowName] = parts;
  const paneIndex = parts.slice(3).join('|');
  if (!/^[0-9]+$/.test(windowIndex ?? '') || !/^[0-9]+$/.test(paneIndex)) return null;
  for (const value of [serverName, sessionName, windowName]) {
    if (hasJsonSpecial(value ?? '')) return null;
  }
  return { sessionName, windowIndex: Number(windowIndex), windowName, paneIndex: Number(paneIndex), muxPaneRef: tmuxPane };
}

/** The request body for an identified pane. Key order is the one of the bash `printf` templates (the parity test compares the text). */
export function buildBody({ serverName, identity, event, sessionId, content }) {
  const head = 'misaoPaneId' in identity
    ? { serverName, misaoPaneId: identity.misaoPaneId, event }
    : {
        serverName,
        sessionName: identity.sessionName,
        windowIndex: identity.windowIndex,
        windowName: identity.windowName,
        paneIndex: identity.paneIndex,
        event,
        muxPaneRef: identity.muxPaneRef,
      };
  return JSON.stringify({ ...head, ...(sessionId ? { sessionId } : {}), ...(content !== undefined ? { content } : {}) });
}

/** The question card of an AskUserQuestion permission request, or undefined for a body that has none (azito-question.sh). */
export function buildQuestionContent(stdinText) {
  try {
    const payload = JSON.parse(stdinText);
    const questions = payload && payload.tool_input && payload.tool_input.questions;
    if (!Array.isArray(questions) || questions.length === 0) return undefined;
    const normalized = questions.map((q) => ({
      question: String((q && q.question) || ''),
      header: q && q.header != null ? String(q.header) : undefined,
      multiSelect: !!(q && q.multiSelect),
      options: (q && Array.isArray(q.options) ? q.options : []).map((o) => ({
        label: String((o && o.label) || ''),
        description: o && o.description != null ? String(o.description) : undefined,
      })),
    }));
    return { toolName: String(payload.tool_name), questions: normalized };
  } catch {
    return undefined;
  }
}

/**
 * Decides what one hook invocation sends. Returns `{ url, token, body, timeoutMs }`, or null when nothing is to be sent.
 * Everything the invocation depends on is a parameter so the rules can be tested without a process.
 */
export async function planHook({ args, env, homeDir, stdinText, readFile = (p) => fs.readFileSync(p, 'utf8'), tmux = askTmux, hostname = os.hostname }) {
  const { kind, event, prefix } = args;

  if (kind === 'notify') {
    const { url, token } = resolveNotifyProfile({ env, homeDir, prefix, readFile });
    if (!token) return null;
    const body = JSON.stringify({ server: hostname(), summary: 'Agent task completed' });
    return { url: `${url}/api/webhooks/agent-done`, token, body, timeoutMs: NOTIFY_TIMEOUT_MS };
  }

  if (kind === 'question' && extractStringField(stdinText, 'tool_name') !== 'AskUserQuestion') return null;
  if (kind === 'activity' && event !== 'start' && event !== 'stop') return null;

  const { url, token, serverName } = resolveProfile({ env, homeDir, prefix, readFile });
  if (!token || !serverName) return null;

  let sessionId = '';
  if (kind === 'activity' || kind === 'session') {
    const found = extractStringField(stdinText, 'session_id');
    sessionId = SESSION_ID.test(found) ? found : '';
    if (kind === 'session' && !sessionId) return null;
  }
  if (kind === 'interaction' && IGNORED_NOTIFICATION_TYPES.has(extractStringField(stdinText, 'notification_type'))) return null;

  const identity = await resolveIdentity({ env, serverName, tmux });
  if (!identity) return null;

  const hookEvent = kind === 'activity' ? event : kind === 'session' ? 'session' : 'open';
  let body = buildBody({ serverName, identity, event: hookEvent, sessionId });
  if (kind === 'question') {
    const content = buildQuestionContent(stdinText);
    if (content !== undefined) {
      const candidate = buildBody({ serverName, identity, event: hookEvent, content });
      // Too large a question would only be cut by the hub; the banner without the card still gets through.
      if (Array.from(candidate).length <= MAX_QUESTION_PAYLOAD_CHARS) body = candidate;
    }
  }
  const route = kind === 'activity' || kind === 'session' ? 'agent-activity' : 'agent-interaction';
  return { url: `${url}/api/webhooks/${route}`, token, body, timeoutMs: DELIVER_TIMEOUT_MS };
}

/** POSTs a plan. Never throws: a hub that is down is not Claude Code's problem. */
export async function deliver({ url, token, body, timeoutMs }) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer();
  } catch { /* fire and forget */ }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

/** Hands the plan to a detached copy of this script over stdin (the token never appears in an argv), and returns at once. */
function deliverInBackground(plan) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--deliver'], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(plan));
  child.unref();
}

async function main() {
  if (process.argv[2] === '--deliver') {
    try {
      await deliver(JSON.parse(await readStdin()));
    } catch { /* nothing to report to */ }
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;
  // Every non-notify hook consumes its stdin (a hook that leaves the payload unread can make the caller's write block).
  const stdinText = args.kind === 'notify' ? '' : await readStdin();
  const plan = await planHook({ args, env: process.env, homeDir: os.homedir(), stdinText });
  if (plan) deliverInBackground(plan);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // No process.exit: the pipe to the detached copy has to be flushed first; the exit code stays 0.
  main().catch(() => {});
}
