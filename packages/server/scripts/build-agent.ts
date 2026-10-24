import { execSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';
import { assertAgentBundleComplete, AGENT_LAUNCHER_PATH, AGENT_PTY_NODE_PATH, describeNotLinuxX64Elf, isNodePtySpawnHelper } from '../src/modules/servers/agent-deploy/agentBundleCheck';
import { collectTreeEntries, packTarGz } from '../src/shared/fs/tarGz';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const DIST = path.join(ROOT, 'dist-agent');
const STAGE = path.join(DIST, 'stage');

function getGitSha(): string {
  return execSync('git rev-parse --short HEAD', { cwd: ROOT, timeout: 5000 })
    .toString()
    .trim();
}

/**
 * Deterministic content hash of a directory's files (sorted relative path + contents),
 * independent of filesystem metadata (mtime, permissions) and of tar's own output —
 * `tar czf` is not byte-reproducible across runs (embeds per-entry timestamps), so the
 * tarball itself cannot be hashed for version comparison purposes.
 */
function hashDirContents(dir: string): string {
  const files: string[] = [];
  const walk = (sub: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.posix.join(sub, entry.name);
      if (entry.isDirectory()) walk(rel);
      else files.push(rel);
    }
  };
  walk('.');
  files.sort();

  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    // Forward slashes, sorted as such (above), so the hash is the same whichever OS built the bundle.
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, rel)));
  }
  return hash.digest('hex').slice(0, 12);
}

async function main(): Promise<void> {
  const sha = getGitSha();
  console.log(`[build-agent] Building agent bundle (SHA: ${sha})`);

  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'agent', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: path.join(STAGE, 'azito-agent.cjs'),
    external: ['node-pty', 'cpu-features', 'ssh2', 'playwright'],
    logLevel: 'warning',
  });

  // Bundle tui-supervisor alongside azito-agent.cjs, at the same STAGE root —
  // SupervisorPath.ts's resolveSupervisorCommand() for server.type === 'agent'
  // expects it at ~/.azito/agent/current/azito-supervisor.cjs, the same
  // directory run.sh resolves azito-agent.cjs from. node-pty is external here
  // too: its prebuilds are already staged into node_modules/node-pty below
  // (shared with azito-agent.cjs), so both bundles resolve the same copy.
  await esbuild.build({
    entryPoints: [path.join(ROOT, '..', 'tui-supervisor', 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: path.join(STAGE, 'azito-supervisor.cjs'),
    external: ['node-pty'],
    logLevel: 'warning',
  });

  stageNodePty(resolveLinuxNodePtyDir(), path.join(STAGE, 'node_modules', 'node-pty'));

  for (const pkgName of ['playwright', 'playwright-core']) {
    const pkgSrc = path.join(ROOT, 'node_modules', pkgName);
    if (fs.existsSync(pkgSrc)) {
      copyPackageDir(pkgSrc, path.join(STAGE, 'node_modules', pkgName));
    } else {
      const workspacePkg = path.resolve(ROOT, '..', '..', 'node_modules', pkgName);
      if (!fs.existsSync(workspacePkg)) {
        throw new Error(`${pkgName} not found in node_modules`);
      }
      copyPackageDir(workspacePkg, path.join(STAGE, 'node_modules', pkgName));
    }
  }

  const runSh = fs.readFileSync(path.join(SCRIPT_DIR, 'run.sh'), 'utf-8');
  fs.writeFileSync(path.join(STAGE, AGENT_LAUNCHER_PATH), runSh);

  // Content hash computed from the staged payload (before version.txt is added, to avoid
  // the stamp being self-referential) — this is what the deployed agent reports at
  // /health, and what AgentBundler.getBundleHash() compares against.
  const bundleHash = hashDirContents(STAGE);
  fs.writeFileSync(path.join(STAGE, 'version.txt'), bundleHash);

  // Packed in Node with the modes written out: the agent runs on Linux whichever OS built the bundle, and a Windows
  // (or exFAT) file system has no execute bit for the host `tar` to copy into run.sh.
  const tarball = packTarGz(
    collectTreeEntries(STAGE, {
      fileMode: (rel) => (rel === AGENT_LAUNCHER_PATH || isNodePtySpawnHelper(rel) ? 0o755 : 0o644),
      directoryMode: 0o755,
    }),
    Math.floor(Date.now() / 1000),
  );
  assertAgentBundleComplete(tarball, 'the agent tarball just built');
  fs.writeFileSync(path.join(DIST, 'azito-agent.tar.gz'), tarball);

  const tarballSha256 = crypto.createHash('sha256').update(tarball).digest('hex');
  fs.writeFileSync(path.join(DIST, 'SHA256SUMS'), `${tarballSha256}  azito-agent.tar.gz\n`);

  // dist-agent/version.txt: git SHA of the last build, used by needsBuild() to decide
  // whether the hub's local tarball is stale relative to the current checkout.
  fs.writeFileSync(path.join(DIST, 'version.txt'), sha);
  // dist-agent/bundle-hash.txt: sibling to the tarball, read by AgentBundler.getBundleHash().
  fs.writeFileSync(path.join(DIST, 'bundle-hash.txt'), bundleHash);

  fs.rmSync(STAGE, { recursive: true, force: true });

  console.log(`[build-agent] Done → dist-agent/azito-agent.tar.gz (SHA: ${sha}, bundle hash: ${bundleHash})`);
}

/**
 * The directory that holds the Linux x86-64 build of node-pty (`build/Release/pty.node`). The agent runs on Linux, so this is
 * never the hub's own node-pty unless the hub is a Linux x86-64 machine: a Windows or macOS hub (and a Linux arm64 one) has
 * only its own binaries, and a bundle made from them would die at the agent's first `require('node-pty')`.
 * `--node-pty-linux <dir>` (or AZITO_AGENT_NODE_PTY_LINUX, which AgentBundler.ensureBuild passes on) names a node-pty folder
 * built on Linux x86-64; the release workflow builds one once and hands it to every platform's job.
 */
function resolveLinuxNodePtyDir(): string {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf('--node-pty-linux');
  const given = flag === -1 ? process.env.AZITO_AGENT_NODE_PTY_LINUX : argv[flag + 1];
  if (flag !== -1 && !given) throw new Error('--node-pty-linux needs a directory');
  if (given) return path.resolve(given);

  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(
      `This host is ${process.platform}-${process.arch}, so its node-pty cannot run on a Linux x86-64 agent. ` +
        'Pass --node-pty-linux <dir> (or set AZITO_AGENT_NODE_PTY_LINUX) with a node-pty folder built on Linux x86-64 ' +
        '(its build/Release/pty.node).',
    );
  }
  for (const root of [path.join(ROOT, 'node_modules'), path.resolve(ROOT, '..', '..', 'node_modules')]) {
    const candidate = path.join(root, 'node-pty');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('node-pty not found in node_modules');
}

/**
 * node-pty's JS, the Linux binary (`build/Release/pty.node`, from `linuxDir`) and the npm package's own prebuilds (macOS and Windows,
 * debug symbols left out): one bundle serves a Linux, a macOS and a Windows agent, and node-pty picks `build/Release` on Linux and
 * `prebuilds/<platform>-<arch>` elsewhere. (Linux needs no spawn-helper.)
 */
function stageNodePty(linuxDir: string, dest: string): void {
  const native = path.join(linuxDir, 'build', 'Release', 'pty.node');
  if (!fs.existsSync(native)) throw new Error(`${native} does not exist: the directory is not a built node-pty`);
  const notElf = describeNotLinuxX64Elf(fs.readFileSync(native));
  if (notElf) throw new Error(`${native} cannot run on a Linux x86-64 agent: ${notElf}`);

  // lib/, prebuilds/ and package.json come from this checkout's own node-pty (the same on every OS); only pty.node is the Linux one.
  const jsSrc = ['node_modules', path.join('..', '..', 'node_modules')].map((r) => path.join(ROOT, r, 'node-pty')).find((d) => fs.existsSync(path.join(d, 'package.json')));
  if (!jsSrc) throw new Error('node-pty not found in node_modules');
  const linuxVersion = JSON.parse(fs.readFileSync(path.join(linuxDir, 'package.json'), 'utf-8')).version as string;
  const jsVersion = JSON.parse(fs.readFileSync(path.join(jsSrc, 'package.json'), 'utf-8')).version as string;
  if (linuxVersion !== jsVersion) throw new Error(`node-pty ${linuxVersion} (${linuxDir}) does not match this checkout's node-pty ${jsVersion}`);

  fs.mkdirSync(path.join(dest, 'build', 'Release'), { recursive: true });
  fs.copyFileSync(path.join(jsSrc, 'package.json'), path.join(dest, 'package.json'));
  copyDir(path.join(jsSrc, 'lib'), path.join(dest, 'lib'));
  copyDir(path.join(jsSrc, 'prebuilds'), path.join(dest, 'prebuilds'), (name) => !name.endsWith('.pdb'));
  fs.copyFileSync(native, path.join(dest, AGENT_PTY_NODE_PATH.replace('node_modules/node-pty/', '')));
}

function copyDir(src: string, dest: string, include: (fileName: string) => boolean = () => true): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, include);
    } else if (include(entry.name)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Copies an entire package directory (e.g. node_modules/playwright), excluding
// `.local-browsers` — a subdirectory some environments populate with downloaded
// browser binaries, which must not be bundled into the agent tarball.
function copyPackageDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.local-browsers') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

main().catch((err) => {
  console.error('[build-agent] Failed:', err);
  process.exit(1);
});
