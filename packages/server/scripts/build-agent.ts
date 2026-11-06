import { execSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';
import { assertAgentBundleComplete, AGENT_LAUNCHER_PATH, AGENT_PTY_NODE_PATH, AGENT_PTY_ARM64_NODE_PATH, describeNotLinuxElf, isNodePtySpawnHelper } from '../src/modules/servers/agent-deploy/agentBundleCheck';
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

  // A source hub (AgentBundler) may build on Linux x64 without an arm64 node-pty: the bundle then serves x64 agents only, and
  // AgentInstaller refuses a Linux arm64 host with the reason. Release builds never pass the flag, so they still need both.
  const allowMissingLinuxArm64 = process.argv.slice(2).includes(ALLOW_MISSING_ARM64_FLAG);
  const arm64Dir = allowMissingLinuxArm64 ? resolveOptionalLinuxNodePtyDir('arm64') : resolveLinuxNodePtyDir('arm64');
  if (arm64Dir === null) console.warn(`[build-agent] No Linux arm64 node-pty (${ALLOW_MISSING_ARM64_FLAG}): this bundle cannot be installed on Linux arm64 agents. Set AZITO_AGENT_NODE_PTY_LINUX_ARM64 to include it.`);
  stageNodePty(resolveLinuxNodePtyDir('x64'), arm64Dir, path.join(STAGE, 'node_modules', 'node-pty'));

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
  assertAgentBundleComplete(tarball, 'the agent tarball just built', { allowMissingLinuxArm64 });
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

const ALLOW_MISSING_ARM64_FLAG = '--allow-missing-linux-arm64';

function nativeInputNames(arch: 'x64' | 'arm64'): { flagName: string; envName: string } {
  return arch === 'x64'
    ? { flagName: '--node-pty-linux', envName: 'AZITO_AGENT_NODE_PTY_LINUX' }
    : { flagName: '--node-pty-linux-arm64', envName: 'AZITO_AGENT_NODE_PTY_LINUX_ARM64' };
}

/** A native input from an explicit cross-build input or the matching Linux host; null when neither exists. */
function resolveOptionalLinuxNodePtyDir(arch: 'x64' | 'arm64'): string | null {
  const { flagName, envName } = nativeInputNames(arch);
  const argv = process.argv.slice(2);
  const flag = argv.indexOf(flagName);
  const given = flag === -1 ? process.env[envName] : argv[flag + 1];
  if (flag !== -1 && !given) throw new Error(`${flagName} needs a directory`);
  if (given) return path.resolve(given);
  if (process.platform !== 'linux' || process.arch !== arch) return null;
  for (const root of [path.join(ROOT, 'node_modules'), path.resolve(ROOT, '..', '..', 'node_modules')]) {
    const candidate = path.join(root, 'node-pty');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('node-pty not found in node_modules');
}

/** Resolve a native input from the matching Linux host or an explicit cross-build input. */
function resolveLinuxNodePtyDir(arch: 'x64' | 'arm64'): string {
  const dir = resolveOptionalLinuxNodePtyDir(arch);
  if (dir !== null) return dir;
  const { flagName, envName } = nativeInputNames(arch);
  throw new Error(`This host is ${process.platform}-${process.arch}, so its node-pty cannot run on a Linux ${arch === 'x64' ? 'x86-64' : 'arm64'} agent. Pass ${flagName} <dir> (or set ${envName}) with a node-pty folder built on Linux ${arch}.`);
}

function stageNodePty(x64Dir: string, arm64Dir: string | null, dest: string): void {
  const jsSrc = ['node_modules', path.join('..', '..', 'node_modules')].map((r) => path.join(ROOT, r, 'node-pty')).find((d) => fs.existsSync(path.join(d, 'package.json')));
  if (!jsSrc) throw new Error('node-pty not found in node_modules');
  const jsVersion = JSON.parse(fs.readFileSync(path.join(jsSrc, 'package.json'), 'utf-8')).version as string;
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(jsSrc, 'package.json'), path.join(dest, 'package.json'));
  copyDir(path.join(jsSrc, 'lib'), path.join(dest, 'lib'));
  copyDir(path.join(jsSrc, 'prebuilds'), path.join(dest, 'prebuilds'), (name) => !name.endsWith('.pdb'));
  const natives = [[x64Dir, 'x64', AGENT_PTY_NODE_PATH], [arm64Dir, 'arm64', AGENT_PTY_ARM64_NODE_PATH]] as const;
  for (const [source, arch, target] of natives) {
    if (source === null) continue;
    const native = path.join(source, 'build', 'Release', 'pty.node');
    if (!fs.existsSync(native)) throw new Error(`${native} does not exist: the directory is not a built node-pty`);
    const notElf = describeNotLinuxElf(fs.readFileSync(native), arch);
    if (notElf) throw new Error(`${native} cannot run on a Linux ${arch} agent: ${notElf}`);
    const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf-8')).version as string;
    if (version !== jsVersion) throw new Error(`node-pty ${version} (${source}) does not match this checkout's node-pty ${jsVersion}`);
    const output = path.join(dest, target.replace('node_modules/node-pty/', ''));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(native, output);
  }
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
