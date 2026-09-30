import { execSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..');
const DIST = path.join(SERVER_ROOT, 'dist-hub');
const STAGE = path.join(DIST, 'stage');

const DEFAULT_REPO = 'wireframeslayout/azito';
const DEFAULT_NODE_VERSION = 'v24.14.0';

interface Args {
  version: string;
  platform: 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
  repo: string;
  nodeVersion: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Partial<Args> = {};

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--version': args.version = argv[++i]; break;
      case '--platform': args.platform = argv[++i] as Args['platform']; break;
      case '--arch': args.arch = argv[++i] as Args['arch']; break;
      case '--repo': args.repo = argv[++i]; break;
      case '--node-version': args.nodeVersion = argv[++i]; break;
    }
  }

  if (!args.version) throw new Error('--version is required');
  if (!args.platform) throw new Error('--platform is required (linux|darwin)');
  if (!args.arch) throw new Error('--arch is required (x64|arm64)');

  return {
    version: args.version,
    platform: args.platform,
    arch: args.arch,
    repo: args.repo || process.env.AZITO_RELEASE_REPO || DEFAULT_REPO,
    nodeVersion: args.nodeVersion || DEFAULT_NODE_VERSION,
  };
}

function getGitSha(): string {
  return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, timeout: 5000 })
    .toString()
    .trim();
}

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

function resolveNativeModule(name: string): string {
  const local = path.join(SERVER_ROOT, 'node_modules', name);
  if (fs.existsSync(local)) return local;
  const workspace = path.join(REPO_ROOT, 'node_modules', name);
  if (fs.existsSync(workspace)) return workspace;
  throw new Error(`${name} not found in node_modules`);
}

function copyBetterSqlite3(dest: string): void {
  const src = resolveNativeModule('better-sqlite3');
  fs.mkdirSync(dest, { recursive: true });

  const pkgJson = path.join(src, 'package.json');
  if (fs.existsSync(pkgJson)) fs.copyFileSync(pkgJson, path.join(dest, 'package.json'));

  const libDir = path.join(src, 'lib');
  if (fs.existsSync(libDir)) copyDir(libDir, path.join(dest, 'lib'));

  const buildDir = path.join(src, 'build');
  if (fs.existsSync(buildDir)) copyDir(buildDir, path.join(dest, 'build'));

  const prebuildsDir = path.join(src, 'prebuilds');
  if (fs.existsSync(prebuildsDir)) copyDir(prebuildsDir, path.join(dest, 'prebuilds'));
}

function copyNodePty(dest: string): void {
  const src = resolveNativeModule('node-pty');
  fs.mkdirSync(dest, { recursive: true });

  const pkgJson = path.join(src, 'package.json');
  if (fs.existsSync(pkgJson)) fs.copyFileSync(pkgJson, path.join(dest, 'package.json'));

  for (const sub of ['lib', 'build', 'prebuilds']) {
    const subDir = path.join(src, sub);
    if (fs.existsSync(subDir)) copyDir(subDir, path.join(dest, sub));
  }

  // On Unix node-pty execs a `spawn-helper` binary to start the pty. It arrives
  // from the npm tarball without the executable bit (mode 644), and copyFileSync
  // faithfully preserves that — the result is `posix_spawnp failed` on the first
  // terminal open, as an *uncaught* exception that takes the hub down with it.
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

function copySsh2(dest: string): void {
  const src = resolveNativeModule('ssh2');
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

/**
 * Copy a module's runtime dependency tree into the bundle's node_modules.
 *
 * The esbuild bundle marks the native modules as `external`, so they are
 * `require`d at runtime — and so are *their* dependencies (ssh2 needs asn1 and
 * bcrypt-pbkdf, better-sqlite3 needs bindings). Those are plain JS packages
 * that never get bundled, so without this the released hub fails to boot with
 * MODULE_NOT_FOUND. Native/optional packages are skipped: they are either
 * staged separately or genuinely optional at runtime.
 */
function copyRuntimeDeps(moduleName: string, nodeModulesDest: string, seen = new Set<string>()): void {
  const SKIP = new Set(['ssh2', 'better-sqlite3', 'node-pty', 'cpu-features', 'prebuild-install']);
  let pkgDir: string;
  try {
    pkgDir = resolveNativeModule(moduleName);
  } catch {
    return; // optional dependency that is not installed
  }
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return;
  const deps = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')).dependencies ?? {};

  for (const dep of Object.keys(deps)) {
    if (SKIP.has(dep) || seen.has(dep)) continue;
    seen.add(dep);
    let depDir: string;
    try {
      depDir = resolveNativeModule(dep);
    } catch {
      console.warn(`[build-hub] runtime dependency not found, skipping: ${dep}`);
      continue;
    }
    copyDir(depDir, path.join(nodeModulesDest, dep));
    copyRuntimeDeps(dep, nodeModulesDest, seen);
  }
}

function assertStageContents(): void {
  const required = [
    'azito-hub.cjs',
    'azito-supervisor.cjs',
    'release.json',
    'channel.json',
    'version.txt',
    'run.sh',
    'node',
    'public/index.html',
    'harness/chat-commands.json',
    'dist-agent/azito-agent.tar.gz',
    'deploy/azito-release.service',
    'deploy/com.azito.hub.plist',
    // ssh2 / better-sqlite3 require these at boot; missing them means the
    // released hub dies with MODULE_NOT_FOUND before serving anything.
    'node_modules/asn1',
    'node_modules/bcrypt-pbkdf',
    'node_modules/bindings',
    'node_modules/playwright',
    'node_modules/playwright-core',
  ];
  const missing = required.filter(f => !fs.existsSync(path.join(STAGE, f)));
  if (missing.length > 0) {
    throw new Error(`Stage validation failed: missing files: ${missing.join(', ')}`);
  }

  // node-pty execs these; shipping one without +x breaks every terminal.
  const helpers = findFiles(path.join(STAGE, 'node_modules', 'node-pty'), 'spawn-helper');
  if (helpers.length === 0) {
    throw new Error('Stage validation failed: node-pty spawn-helper is missing');
  }
  const notExecutable = helpers.filter(h => (fs.statSync(h).mode & 0o111) === 0);
  if (notExecutable.length > 0) {
    throw new Error(`Stage validation failed: spawn-helper is not executable: ${notExecutable.join(', ')}`);
  }
}

function assertNoDataDir(tarball: string): void {
  const listing = execSync(`tar tzf "${tarball}"`, { timeout: 30000 }).toString();
  const dataEntries = listing.split('\n').filter(l => l.startsWith('data/') || l === 'data');
  if (dataEntries.length > 0) {
    throw new Error(`Tarball contains data/ entries: ${dataEntries.join(', ')}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const commit = getGitSha();
  console.log(`[build-hub] Building hub bundle v${args.version} (${args.platform}-${args.arch}, commit: ${commit})`);

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  // 1. Build frontend
  console.log('[build-hub] Building frontend...');
  execSync('npm run build:web', { cwd: REPO_ROOT, stdio: 'inherit', timeout: 120000 });

  // 2. Build agent bundle
  console.log('[build-hub] Building agent bundle...');
  execSync('npx tsx scripts/build-agent.ts', { cwd: SERVER_ROOT, stdio: 'inherit', timeout: 180000 });

  // 3. esbuild hub bundle
  console.log('[build-hub] Bundling hub server...');
  const sharedAlias = { '@azito/shared': path.resolve(REPO_ROOT, 'packages/shared/src/index.ts') };
  await esbuild.build({
    entryPoints: [path.join(SERVER_ROOT, 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: path.join(STAGE, 'azito-hub.cjs'),
    external: ['better-sqlite3', 'node-pty', 'ssh2', 'cpu-features', 'playwright'],
    alias: sharedAlias,
    logLevel: 'warning',
  });

  // Supervised windows launch tui-supervisor as a separate process. A release
  // install ships no `packages/` tree, so without this bundle SupervisorPath
  // falls through to its dev-mode `npx tsx .../src/main.ts` and the pane dies
  // with ERR_MODULE_NOT_FOUND. Placed at the stage root, next to
  // azito-hub.cjs, matching where the agent bundle puts it. node-pty stays
  // external — both bundles resolve the same staged copy.
  console.log('[build-hub] Bundling tui-supervisor...');
  await esbuild.build({
    entryPoints: [path.join(REPO_ROOT, 'packages', 'tui-supervisor', 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: path.join(STAGE, 'azito-supervisor.cjs'),
    external: ['node-pty'],
    alias: sharedAlias,
    logLevel: 'warning',
  });

  // 4. Stage public/
  const publicDir = path.join(REPO_ROOT, 'public');
  if (fs.existsSync(publicDir)) {
    copyDir(publicDir, path.join(STAGE, 'public'));
  }

  // 5. Stage harness/
  // setup.sh is the entry point HarnessInstaller runs, and it installs
  // skills/ into ~/.claude — without both, "Install AZITO Harness" fails on a
  // release install. tmux/ carries the recommended tmux config.
  for (const sub of ['sidekicks', 'prompt-modules', 'unit-types', 'bin', 'hooks', 'skills', 'tmux']) {
    const src = path.join(REPO_ROOT, 'harness', sub);
    if (fs.existsSync(src)) {
      copyDir(src, path.join(STAGE, 'harness', sub));
    }
  }
  // chat-commands.json: builtin definitions for the chat command palette
  // (ChatCommandLoader reads it at DEFAULT_BUILTIN_CHAT_COMMANDS_PATH); without staging it, a
  // release install silently ships an empty palette (loadFile treats a missing file as "no commands").
  for (const f of ['setup.sh', 'README.md', 'chat-commands.json']) {
    const src = path.join(REPO_ROOT, 'harness', f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(STAGE, 'harness', f));
      if (f.endsWith('.sh')) fs.chmodSync(path.join(STAGE, 'harness', f), 0o755);
    }
  }

  // 6. Stage dist-agent/
  const agentDist = path.join(SERVER_ROOT, 'dist-agent');
  const agentStage = path.join(STAGE, 'dist-agent');
  fs.mkdirSync(agentStage, { recursive: true });
  for (const f of ['azito-agent.tar.gz', 'bundle-hash.txt', 'SHA256SUMS']) {
    const src = path.join(agentDist, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(agentStage, f));
  }

  // 6b. Stage deploy/ service templates
  // install.sh and the manual-install docs both read these from the extracted
  // bundle, so the templates in deploy/ stay the single source of truth for
  // the systemd unit and the launchd plist.
  const deployStage = path.join(STAGE, 'deploy');
  fs.mkdirSync(deployStage, { recursive: true });
  for (const f of ['azito-release.service', 'com.azito.hub.plist']) {
    const src = path.join(REPO_ROOT, 'deploy', f);
    if (!fs.existsSync(src)) throw new Error(`Missing deploy template: ${src}`);
    fs.copyFileSync(src, path.join(deployStage, f));
  }

  // 7. Stage native modules
  const nodeModulesStage = path.join(STAGE, 'node_modules');
  copyBetterSqlite3(path.join(nodeModulesStage, 'better-sqlite3'));
  copyNodePty(path.join(nodeModulesStage, 'node-pty'));
  copySsh2(path.join(nodeModulesStage, 'ssh2'));
  // playwright is required at module load by BrowserSession, so the hub cannot
  // boot without it — a `local` server runs Chromium on the hub itself, not
  // only on remote agents. Browser *binaries* are still downloaded separately.
  copyDir(resolveNativeModule('playwright'), path.join(nodeModulesStage, 'playwright'));
  // Their runtime dependencies are require()d at boot and are not bundled.
  for (const m of ['better-sqlite3', 'node-pty', 'ssh2', 'playwright']) {
    copyRuntimeDeps(m, nodeModulesStage);
  }

  // 8. Stage run.sh
  const runSh = fs.readFileSync(path.join(SCRIPT_DIR, 'run-hub.sh'), 'utf-8');
  fs.writeFileSync(path.join(STAGE, 'run.sh'), runSh, { mode: 0o755 });

  // 9. Download and stage Node binary
  console.log(`[build-hub] Downloading Node.js ${args.nodeVersion} for ${args.platform}-${args.arch}...`);
  execSync(
    `bash "${path.join(SCRIPT_DIR, 'download-node.sh')}" "${args.nodeVersion}" "${args.platform}" "${args.arch}" "${STAGE}"`,
    { stdio: 'inherit', timeout: 120000 },
  );

  // 10. Content hash (before writing version metadata)
  const bundleHash = hashDirContents(STAGE);

  // 11. Write release.json
  const releaseJson = {
    version: args.version,
    commit,
    bundleHash,
    channel: { repo: args.repo },
  };
  fs.writeFileSync(path.join(STAGE, 'release.json'), JSON.stringify(releaseJson, null, 2) + '\n');

  // 12. Write channel.json
  fs.writeFileSync(
    path.join(STAGE, 'channel.json'),
    JSON.stringify({ repo: args.repo }, null, 2) + '\n',
  );

  // 13. Write version.txt
  fs.writeFileSync(path.join(STAGE, 'version.txt'), `${args.version}\n${bundleHash}\n${commit}\n`);

  // 14. Validate stage contents
  assertStageContents();

  // 15. Create tarball
  const tarballName = `azito-hub-${args.version}-${args.platform}-${args.arch}.tar.gz`;
  execSync(`tar czf "${tarballName}" -C stage .`, { cwd: DIST });
  const tarballPath = path.join(DIST, tarballName);

  // 16. Verify no data/ in tarball
  assertNoDataDir(tarballPath);

  // 17. Generate SHA256SUMS
  const tarballSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(tarballPath))
    .digest('hex');
  fs.writeFileSync(path.join(DIST, 'SHA256SUMS'), `${tarballSha256}  ${tarballName}\n`);

  // Cleanup stage
  fs.rmSync(STAGE, { recursive: true, force: true });

  console.log(`[build-hub] Done → dist-hub/${tarballName} (hash: ${bundleHash})`);
}

main().catch((err) => {
  console.error('[build-hub] Failed:', err);
  process.exit(1);
});
