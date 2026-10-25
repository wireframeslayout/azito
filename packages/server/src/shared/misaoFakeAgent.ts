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
