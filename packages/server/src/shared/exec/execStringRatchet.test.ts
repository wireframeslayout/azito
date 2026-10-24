import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Ratchet (#379 P6): `transport.exec(<shell string>)` is the POSIX-only API (`/bin/sh -c`, refused on a win32 host). New
 * code runs programs with `transport.run(<CommandSpec>)` (no shell), or the file operations of IFileOps (P7). This test
 * counts the calls that remain, per file, and fails when a count differs from the table below:
 *
 * - a file that gained a call: use `run`, or `transport.files()` (IFileOps); do not add the call here;
 * - a file that lost a call: lower its number (delete the line at zero), so the ratchet only ever tightens.
 *
 * What it counts, in non-test code, on lines that are not comments: a call on a receiver that is a transport —
 * `transport.exec(`, `target.exec(`, `this.transport.exec(`, `<factory>.getTransport(...).exec(` — and `this.exec(` / `this.out(` (the
 * private wrappers around one). `db.exec(`, `RegExp#exec` and `llmClient.exec(` are not transports and not counted.
 */
const SRC_ROOT = path.resolve(__dirname, '..', '..');

const EXEC_STRING_CALL = /(?:[tT]ransport|\btarget|getTransport\([^)]*\))\.exec\(|\bthis\.(?:exec|out)\(/g;

/** Remaining calls by file, relative to src/, grouped by what is to replace them. */
const REMAINING: Record<string, number> = {
  // C-1: shell file operations (find / test / wc / cat / rm / mkdir...) → IFileOps (P7, P7b). What is left:
  // - the shell implementation of IFileOps for an agent registered before its OS was recorded (a Unix one without
  //   /api/fileops); its walk (`find`, the file-name search and the session scans) and its replaceDirectory (one script) are among them. AgentTransport.files() chooses it once; every other file operation goes through IFileOps
  'modules/servers/transport/ShellFileOps.ts': 24,
  // - the sidekick sync of such an agent (tar + base64 through exec); every other host writes the tarball with IFileOps and runs `tar`
  'modules/sidekicks/shellSidekickSync.ts': 6,
  'modules/tasks/execution/WorkerWaiter.ts': 2,
  'modules/tasks/execution/GitInfoCollector.ts': 2, // git commands, not yet moved (not in P6's list)
  // C-2: Unix-only install scripts. They stay sh; each entry point first refuses a win32 server with unsupported_os (P9,
  // `assertPosixHost`), and the Windows versions are separate functions added with the Windows agent (#369 / #380). The OS probes
  // (`uname`, `echo $HOME`) are gone: the OS comes from the recorded host profile.
  'modules/servers/agent-deploy/BrowserRuntimeInstaller.ts': 12,
  'modules/servers/agent-deploy/TmuxInstaller.ts': 7,
  'modules/system/misao/MisaoAgentInstaller.ts': 10,
  'modules/git/hub-transfer/RemoteBundleOps.ts': 15,
  'modules/servers/isolationDoctor.ts': 1,
  'modules/servers/routes.ts': 3, // the harness check, the Chromium check, apply-tmux-config: shell scripts
  // the host's memory / load / disk measurement script (sh): not a process list, so it was not moved with the `ps` calls (#371 T1)
  'modules/servers/resources/ResourceGuard.ts': 1,
  // the sentinel wrapper for the remaining remote git commands, and the shell route of a recorded-host-less agent's run()
  'modules/git/execWithSentinel.ts': 2,
  'modules/servers/transport/AgentTransport.ts': 1,
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !full.includes(`${path.sep}testing${path.sep}`)) out.push(full);
  }
  return out;
}

function countCalls(source: string): number {
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  return code.match(EXEC_STRING_CALL)?.length ?? 0;
}

function currentCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of listSourceFiles(SRC_ROOT).sort()) {
    const count = countCalls(fs.readFileSync(file, 'utf-8'));
    if (count > 0) counts[path.relative(SRC_ROOT, file).split(path.sep).join('/')] = count;
  }
  return counts;
}

describe('exec(<shell string>) ratchet', () => {
  it('counts only calls on a transport', () => {
    expect(countCalls('await transport.exec(cmd);\nawait this.transportFactory.getTransport(srv).exec(cmd);\nthis.exec(a); target.exec(b); this.out(c);')).toBe(5);
    expect(countCalls('db.exec(sql); re.exec(s); this.llmClient.exec(p);\n// transport.exec(x)\n * transport.exec(y)')).toBe(0);
  });

  it('has no more (and no fewer) exec(<shell string>) calls than the table says', () => {
    expect(currentCounts()).toEqual(REMAINING);
  });
});
