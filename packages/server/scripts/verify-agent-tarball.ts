import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hostTar } from './archive';
import { AGENT_LAUNCHER_PATH, AGENT_PTY_NODE_PATH, findAgentBundleProblems } from '../src/modules/servers/agent-deploy/agentBundleCheck';

/**
 * Checks an agent tarball the way a Linux agent host will meet it, with two readers: the hub's own (the file list, the modes,
 * the ELF header of pty.node) and this host's `tar` (bsdtar on Windows and macOS, GNU tar on Linux), whose listing must show
 * the launcher executable and whose extraction must give back the same pty.node bytes. A bundle built on Windows is verified
 * on that Windows runner, where a file system has no execute bit to fall back on.
 * Usage: tsx verify-agent-tarball.ts <azito-agent.tar.gz>
 */

function main(): void {
  const tarball = process.argv[2];
  if (!tarball) throw new Error('usage: verify-agent-tarball.ts <azito-agent.tar.gz>');
  const archive = path.resolve(tarball);
  const problems = findAgentBundleProblems(fs.readFileSync(archive));
  if (problems.length > 0) throw new Error(`${archive}: ${problems.join('; ')}`);

  const tar = hostTar();
  const listing = execFileSync(tar, ['-tzvf', archive], { maxBuffer: 256 * 1024 * 1024 }).toString().split(/\r?\n/);
  const launcher = listing.find((line) => line.endsWith(` ${AGENT_LAUNCHER_PATH}`));
  if (!launcher || !/^-rwx/.test(launcher)) throw new Error(`the host tar lists ${AGENT_LAUNCHER_PATH} as: ${launcher ?? '(absent)'}`);
  console.log(`[verify-agent-tarball] ${tar} lists: ${launcher.trim()}`);

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-agent-verify-'));
  try {
    execFileSync(tar, ['-xzf', archive, '-C', out, AGENT_PTY_NODE_PATH]);
    const extracted = fs.readFileSync(path.join(out, ...AGENT_PTY_NODE_PATH.split('/')));
    const head = extracted.subarray(0, 4).toString('latin1');
    if (head !== '\x7fELF') throw new Error(`${AGENT_PTY_NODE_PATH} extracted by the host tar does not start with an ELF header`);
    console.log(`[verify-agent-tarball] ${AGENT_PTY_NODE_PATH}: ${extracted.length} bytes, ELF x86-64`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  console.log(`[verify-agent-tarball] OK: ${archive}`);
}

main();
