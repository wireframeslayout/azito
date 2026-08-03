import * as fs from 'fs';
import * as path from 'path';
import type { ServerConfig } from '../servers/Server';

// Local copy of modules/agents/shellQuote.ts — modules/supervisors is
// base-layer (see .dependency-cruiser.cjs base-supervisors-limited) and may
// not import mid-layer modules/agents; importing SupervisorLaunch's copy
// would be circular (SupervisorLaunch imports this file). Keep in sync with
// modules/agents/shellQuote.ts if either changes.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

import { resolveRoot } from '../../shared/releaseInfo';

const REPO_ROOT = resolveRoot();

/**
 * Release bundle layout: `azito-supervisor.cjs` sits next to `azito-hub.cjs`
 * (staged by build-hub.ts), mirroring how the agent bundle ships it. A release
 * install has no `packages/` tree at all, so without this the dev-mode
 * `npx tsx packages/tui-supervisor/src/main.ts` fallback below is reached and
 * fails with ERR_MODULE_NOT_FOUND when a supervised window starts.
 */
function releaseSupervisorPath(root: string): string {
  return path.join(root, 'azito-supervisor.cjs');
}

/** Node binary shipped inside the release bundle — the one runtime guaranteed present. */
function releaseNodePath(root: string): string {
  return path.join(root, 'node');
}

/** Built esbuild bundle produced by packages/tui-supervisor/scripts/build.ts. */
function localSupervisorDistPath(repoRoot: string): string {
  return path.join(repoRoot, 'packages', 'tui-supervisor', 'dist', 'azito-supervisor.cjs');
}

/** Dev-mode entry point, run via `npx tsx` when the dist bundle hasn't been built yet. */
function localSupervisorSrcPath(repoRoot: string): string {
  return path.join(repoRoot, 'packages', 'tui-supervisor', 'src', 'main.ts');
}

/**
 * Path to `azito-supervisor.cjs` on agent servers, as deployed by build-agent.ts
 * (staged alongside `azito-agent.cjs`/`run.sh` at `~/.azito/agent/<version>/`,
 * symlinked to `~/.azito/agent/current/` — see AgentInstaller.ts). The `~` is
 * intentionally left for the remote shell to expand, mirroring
 * REMOTE_AZITOCTL_PATH in AzitoctlPath.ts: this string is rendered into a
 * command that is typed into the target pane's own interactive shell (via
 * tmux send-keys / the agent transport's PTY), never through our exec layer,
 * so tilde expansion is always safe there. Unlike the local paths below, it
 * must NOT be shell-quoted — quoting would suppress that tilde expansion (the
 * path itself contains no spaces/metacharacters by construction).
 */
const AGENT_SUPERVISOR_PATH = '~/.azito/agent/current/azito-supervisor.cjs';

/**
 * Resolves the shell command used to launch `tui-supervisor` on the target
 * execution environment (AZITO監視強化 Phase 3b, Step 4).
 *
 * - local: prefers the built dist bundle (`node <path>`); falls back to
 *   `npx tsx <src/main.ts>` for dev checkouts that haven't run
 *   `packages/tui-supervisor/scripts/build.ts` yet. Both paths are
 *   shell-quoted — the workspace checkout path may contain spaces or shell
 *   metacharacters.
 * - agent: the agent bundle always ships `azito-supervisor.cjs` next to
 *   `azito-agent.cjs` (build-agent.ts), invoked via the pane's own PATH
 *   `node` — the agent transport's PTY runs an interactive shell, unlike the
 *   systemd-launched agent process itself (run.sh), so the elaborate
 *   nvm/nodenv PATH bootstrap that run.sh needs is not required here.
 *
 * `repoRoot` is injectable for tests only; production callers use the default.
 */
export function resolveSupervisorCommand(server: Pick<ServerConfig, 'type'>, repoRoot: string = REPO_ROOT): string {
  if (server.type === 'local') {
    const releasePath = releaseSupervisorPath(repoRoot);
    if (fs.existsSync(releasePath)) {
      // Bundled node rather than the pane's `node`: a release install does not
      // require host Node.js, so the pane may have none on PATH.
      return `${shellQuote(releaseNodePath(repoRoot))} ${shellQuote(releasePath)}`;
    }

    const distPath = localSupervisorDistPath(repoRoot);
    if (fs.existsSync(distPath)) {
      return `node ${shellQuote(distPath)}`;
    }
    return `npx tsx ${shellQuote(localSupervisorSrcPath(repoRoot))}`;
  }

  if (server.type === 'agent') {
    return `node ${AGENT_SUPERVISOR_PATH}`;
  }

  throw new Error(`resolveSupervisorCommand: unsupported server type '${server.type}'`);
}
