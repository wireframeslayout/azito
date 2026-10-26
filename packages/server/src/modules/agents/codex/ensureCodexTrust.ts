// smol-toml is ESM-only; static import fails tsc under Node16/CJS resolution (same as sidekicks/unitTypeSchema.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parse: parseToml } = require('smol-toml') as { parse: (raw: string) => Record<string, unknown> };
import { createHash } from 'node:crypto';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { FileOpsError } from '../../../shared/fs/fileOps';
import { KeyedMutex } from '../../../shared/keyedMutex';
import { pathApiFor } from '../../../shared/os/hostPath';
import { codexHomeOf, type LocalAgentHomes } from '../agentHomes';
import { realpathOrSelf } from '../claude/claudeConfigPath';

/** Two tasks registering at once would each read the same file and the later write would drop the earlier registration. */
const codexConfigLocks = new KeyedMutex();

export type EnsureCodexTrustResult =
  | { action: 'registered'; key: string }
  | { action: 'already_trusted' }
  | { action: 'skipped'; reason: string }
  | { action: 'failed'; reason: string };

type TrustPlatform = 'win32' | 'posix';

/**
 * The key codex files a project under in `[projects."<key>"]` of `$CODEX_HOME/config.toml`.
 * Read from codex-rs (identical in rust-v0.149.0 and rust-v0.164.0): `project_trust_key` / `normalized_project_trust_keys`
 * (codex-rs/config/src/loader/mod.rs) build the key from the canonical path, and `ProjectTrustContext::decision_for_dir` looks the
 * directory the worker runs in up first (then the project root, then the root of the main repository of a linked worktree, which is
 * what the trust screen's "Trusting will apply to the repository root" writes). So the exact directory is a hit by itself. On Windows
 * both sides are compared lower-cased, but not with the separators changed: the key is the host's own backslash spelling.
 */
export function codexProjectKey(platform: TrustPlatform, projectPath: string): string {
  if (platform !== 'win32') return projectPath;
  const pathApi = pathApiFor('win32');
  const normalized = pathApi.normalize(projectPath.replace(/^\\\\\?\\/, ''));
  const root = pathApi.parse(normalized).root;
  return root + normalized.slice(root.length).replace(/\\+$/, '');
}

/** A TOML basic string (JSON's escapes are a subset of TOML's). */
function tomlString(text: string): string {
  return JSON.stringify(text);
}

/** Case-insensitively on Windows, as codex compares them. */
function sameKey(platform: TrustPlatform, a: string, b: string): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Marks `projectPath` as trusted in the server host's `$CODEX_HOME/config.toml` (`~/.codex`), so codex does not stop at its "Do you
 * trust the contents of this directory?" screen. Only the section of this project is added, at the end of the file: nothing of what
 * the file holds is parsed and written back, so comments, order and every other setting stay as they are. The result is parsed again
 * before it is written; a file this cannot extend (the project already has a table without a trust level, `projects` written as an
 * inline table) is reported as `failed` and left alone, and so is a file that is not valid TOML. The write is atomic, keeps the file's
 * permission bits and is refused if the file changed after it was read. An existing `trust_level` (even "untrusted") is a person's
 * decision and is not changed. A missing file is created.
 */
export async function ensureCodexTrust(
  transport: IServerTransport,
  projectPath: string,
  homes: LocalAgentHomes,
  isLocal: boolean,
): Promise<EnsureCodexTrustResult> {
  const ops = transport.files();
  const platform: TrustPlatform = ops.platform === 'win32' ? 'win32' : 'posix';
  const key = codexProjectKey(platform, projectPath);
  const pathApi = pathApiFor(ops.platform);
  const configPath = await realpathOrSelf(ops, pathApi.join(await codexHomeOf(ops, isLocal, homes), 'config.toml'));
  return codexConfigLocks.withLock(configPath, async () => {
    let raw: Buffer | null = null;
    try {
      raw = (await ops.read(configPath)).data;
    } catch (err) {
      if (!(err instanceof FileOpsError && err.code === 'NOT_FOUND')) throw err;
    }
    const current = raw === null ? '' : raw.toString('utf8');

    let projects: Record<string, unknown>;
    try {
      projects = (parseToml(current).projects ?? {}) as Record<string, unknown>;
    } catch (err) {
      return { action: 'failed', reason: `config.toml is not valid TOML: ${err instanceof Error ? err.message : String(err)}` };
    }

    const existingKey = Object.keys(projects).find((candidate) => sameKey(platform, candidate, key));
    const existing = existingKey === undefined ? undefined : (projects[existingKey] as { trust_level?: unknown });
    if (existing?.trust_level === 'trusted') return { action: 'already_trusted' };
    if (existing?.trust_level !== undefined) {
      return { action: 'skipped', reason: `the project is already marked "${String(existing.trust_level)}" in config.toml` };
    }

    const separator = current === '' || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    const updated = `${current}${separator}[projects.${tomlString(key)}]\ntrust_level = "trusted"\n`;
    try {
      const reparsed = (parseToml(updated).projects ?? {}) as Record<string, { trust_level?: unknown }>;
      if (reparsed[key]?.trust_level !== 'trusted') throw new Error('the section was not read back as trusted');
    } catch (err) {
      return { action: 'failed', reason: `config.toml cannot be extended with the project's section: ${err instanceof Error ? err.message : String(err)}` };
    }

    try {
      if (raw === null) await ops.create(pathApi.dirname(configPath), 'directory', { recursive: true });
      const expect = raw === null ? undefined : { expect: { sha256: createHash('sha256').update(raw).digest('hex') } };
      await ops.write(configPath, Buffer.from(updated, 'utf8'), expect);
    } catch (err) {
      if (err instanceof FileOpsError) return { action: 'failed', reason: `atomic write failed: ${err.message}` };
      throw err;
    }
    return { action: 'registered', key };
  });
}
