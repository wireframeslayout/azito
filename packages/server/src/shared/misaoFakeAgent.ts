import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Test support: a stand-in for `claude` / `codex` that the `*.misaoIntegration.test.ts` files start in a real misao pane. It prints where
 * and how it was started (its working directory, its arguments exactly as it got them, one env variable, its terminal size) and then
 * stays alive, like an agent waiting for input.
 */
const FAKE_AGENT_SOURCE = [
  "const mark = 'FAKE-AGENT';",
  "const report = { cwd: process.cwd(), args: process.argv.slice(2), env: process.env.AZITO_FAKE_ENV ?? null, cols: process.stdout.columns, rows: process.stdout.rows };",
  "console.log(mark + ' ' + JSON.stringify(report));",
  'setInterval(() => {}, 1000);',
  '',
].join('\n');

export interface FakeAgent {
  /** The JS file (run it with `process.execPath`). */
  script: string;
  /** A directory with `fake-agent.cmd` in it, which runs the script: put it on a pane's PATH and start `fake-agent` (Windows resolves the extension through PATHEXT). */
  shimDir: string;
}

/** Writes the fake agent and its `.cmd` shim under `dir`. */
export function writeFakeAgent(dir: string): FakeAgent {
  const script = path.join(dir, 'fake-agent.js');
  fs.writeFileSync(script, FAKE_AGENT_SOURCE);
  const shimDir = path.join(dir, 'shim');
  fs.mkdirSync(shimDir, { recursive: true });
  // `%*` hands every argument over as it was given; the node.exe path is absolute so the shim needs nothing from PATH.
  fs.writeFileSync(path.join(shimDir, 'fake-agent.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return { script, shimDir };
}

/** The report the fake agent printed on `screen`, or null when it has not printed it yet. */
export function readFakeAgentReport(screen: string): { cwd: string; args: string[]; env: string | null; cols: number | null; rows: number | null } | null {
  // A long line is wrapped at the pane's width: the report is read from the unwrapped text.
  const match = /FAKE-AGENT (\{[^}]*\})/.exec(screen.replace(/\r?\n/g, ''));
  return match ? (JSON.parse(match[1]) as { cwd: string; args: string[]; env: string | null; cols: number | null; rows: number | null }) : null;
}

/**
 * Test support: a stand-in for a task's worker on Windows (#371). Started as a window's first pane, it does what the Windows prompt envelope
 * tells a worker to do, with the real scripts: writes the phase output with `azitoctl.mjs output` (the content on stdin), pushes the work
 * branch with `push.mjs`, and finally appends the done marker with `azitoctl.mjs signal`. Everything comes from the environment:
 * AZITO_FAKE_NODE (a real node.exe), AZITO_FAKE_CTL, AZITO_FAKE_PUSH, AZITO_FAKE_OUTPUT, AZITO_FAKE_CONTENT, AZITO_FAKE_SIGNAL, AZITO_FAKE_MARKER.
 * It prints `TASK-AGENT-DONE {"output":0,"push":0,"signal":0}` (the exit codes) and stays alive.
 */
const TASK_AGENT_SOURCE = [
  "const { spawnSync } = require('node:child_process');",
  'const e = process.env;',
  'const clean = { ...e };',
  'delete clean.NODE_OPTIONS;',
  'const run = (args, extra, input) => spawnSync(e.AZITO_FAKE_NODE, args, { env: { ...clean, ...extra }, input, encoding: "utf8" });',
  "const output = run([e.AZITO_FAKE_CTL, 'output', '--file', e.AZITO_FAKE_OUTPUT], {}, e.AZITO_FAKE_CONTENT);",
  "const sent = run([e.AZITO_FAKE_PUSH], { AZITO_COMMIT_MESSAGE: 'feat: from the fake agent', AZITO_SKIP_PR: '1' });",
  "const signal = run([e.AZITO_FAKE_CTL, 'signal', '--file', e.AZITO_FAKE_SIGNAL, '--marker', e.AZITO_FAKE_MARKER], {});",
  "console.log('TASK-AGENT-DONE ' + JSON.stringify({ output: output.status, push: sent.status, signal: signal.status }));",
  'setInterval(() => {}, 1000);',
  '',
].join('\n');

export interface FakeTaskAgent {
  script: string;
  /** `fake-task-cmd.cmd` (the npm shim shape, like `codex.cmd`): runs the script with node. */
  cmdShimDir: string;
  /** `fake-task-exe.exe` (the native binary shape, like `claude.exe`): a copy of node.exe that runs the script through `NODE_OPTIONS`. */
  exeDir: string;
  /** The env that makes the `.exe` copy run the script (it is given arguments that are not a script). */
  exeEnv: Record<string, string>;
}

export function writeFakeTaskAgent(dir: string): FakeTaskAgent {
  const script = path.join(dir, 'fake-task-agent.cjs');
  fs.writeFileSync(script, TASK_AGENT_SOURCE);
  const cmdShimDir = path.join(dir, 'task-cmd');
  fs.mkdirSync(cmdShimDir, { recursive: true });
  fs.writeFileSync(path.join(cmdShimDir, 'fake-task-cmd.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const exeDir = path.join(dir, 'task-exe');
  fs.mkdirSync(exeDir, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(exeDir, 'fake-task-exe.exe'));
  return { script, cmdShimDir, exeDir, exeEnv: { NODE_OPTIONS: `--require ${JSON.stringify(script)}` } };
}

/** The exit codes the task fake agent printed on `screen`, or null when it has not finished yet. */
export function readFakeTaskAgentResult(screen: string): { output: number; push: number; signal: number } | null {
  const match = /TASK-AGENT-DONE (\{[^}]*\})/.exec(screen.replace(/\r?\n/g, ''));
  return match ? (JSON.parse(match[1]) as { output: number; push: number; signal: number }) : null;
}
