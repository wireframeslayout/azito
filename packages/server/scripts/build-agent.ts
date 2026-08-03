import { execSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

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
      const rel = path.join(sub, entry.name);
      if (entry.isDirectory()) walk(rel);
      else files.push(rel);
    }
  };
  walk('.');
  files.sort();

  const hash = crypto.createHash('sha256');
  for (const rel of files) {
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

  const nodePtySrc = path.join(ROOT, 'node_modules', 'node-pty');
  if (!fs.existsSync(nodePtySrc)) {
    const workspaceNodePty = path.resolve(ROOT, '..', '..', 'node_modules', 'node-pty');
    if (!fs.existsSync(workspaceNodePty)) {
      throw new Error('node-pty not found in node_modules');
    }
    copyNodePty(workspaceNodePty, path.join(STAGE, 'node_modules', 'node-pty'));
  } else {
    copyNodePty(nodePtySrc, path.join(STAGE, 'node_modules', 'node-pty'));
  }

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
  fs.writeFileSync(path.join(STAGE, 'run.sh'), runSh, { mode: 0o755 });

  // Content hash computed from the staged payload (before version.txt is added, to avoid
  // the stamp being self-referential) — this is what the deployed agent reports at
  // /health, and what AgentBundler.getBundleHash() compares against.
  const bundleHash = hashDirContents(STAGE);
  fs.writeFileSync(path.join(STAGE, 'version.txt'), bundleHash);

  execSync(`tar czf azito-agent.tar.gz -C stage .`, { cwd: DIST });

  const tarballSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(DIST, 'azito-agent.tar.gz')))
    .digest('hex');
  fs.writeFileSync(path.join(DIST, 'SHA256SUMS'), `${tarballSha256}  azito-agent.tar.gz\n`);

  // dist-agent/version.txt: git SHA of the last build, used by needsBuild() to decide
  // whether the hub's local tarball is stale relative to the current checkout.
  fs.writeFileSync(path.join(DIST, 'version.txt'), sha);
  // dist-agent/bundle-hash.txt: sibling to the tarball, read by AgentBundler.getBundleHash().
  fs.writeFileSync(path.join(DIST, 'bundle-hash.txt'), bundleHash);

  fs.rmSync(STAGE, { recursive: true, force: true });

  console.log(`[build-agent] Done → dist-agent/azito-agent.tar.gz (SHA: ${sha}, bundle hash: ${bundleHash})`);
}

function copyNodePty(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });

  const pkgJson = path.join(src, 'package.json');
  if (fs.existsSync(pkgJson)) {
    fs.copyFileSync(pkgJson, path.join(dest, 'package.json'));
  }

  const libDir = path.join(src, 'lib');
  if (fs.existsSync(libDir)) {
    copyDir(libDir, path.join(dest, 'lib'));
  }

  const buildDir = path.join(src, 'build');
  if (fs.existsSync(buildDir)) {
    copyDir(buildDir, path.join(dest, 'build'));
  }

  const prebuildsDir = path.join(src, 'prebuilds');
  if (fs.existsSync(prebuildsDir)) {
    copyDir(prebuildsDir, path.join(dest, 'prebuilds'));
  }

  // node-pty execs `spawn-helper` to start a pty, and the npm tarball ships it
  // without the executable bit — copyFileSync preserves that 644 and every
  // terminal then dies with "posix_spawnp failed". Same fix as build-hub.ts.
  for (const helper of findFiles(dest, 'spawn-helper')) {
    fs.chmodSync(helper, 0o755);
  }
}

/** Absolute paths of every file named `name` under `dir`. */
function findFiles(dir: string, name: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(full, name));
    else if (entry.name === name) found.push(full);
  }
  return found;
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
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
