import type { FastifyPluginCallback } from 'fastify';
import type { IProjectRepository, RepositoryProvider } from './Project';
import type { IProjectServerRepository } from './ProjectServer';
import { resolveInputPolicy } from './ProjectServer';
import type { ITaskRepository } from '../tasks/Task';
import type { TaskOriginationService } from '../tasks/origination/TaskOriginationService';
import { originFromPrincipal } from '../tasks/origination/TaskOriginationService';
// request.principal is always set by buildServer.ts's onRequest hook in
// production; the fallback below exists only for route-level unit tests
// that register this plugin directly (bypassing that hook) — same
// convention as originFromPrincipal() itself.
import { OPERATOR_PRINCIPAL } from '../../shared/auth/Principal';
import type { GitProviderService } from '../git/providers/GitProviderService';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { IServerRepository } from '../servers/Server';
import type { SqliteProjectSecretRepository } from './SqliteProjectSecretRepository';
// Issue #29 review (independent QC), M-3: imported from the base-layer
// `modules/servers` (not `modules/tasks/execution/WindowRotation`, which
// merely re-exports it) — this route file's own `resolveInputPolicy` doc
// comment in `./ProjectServer.ts` states it "cannot import from tasks", and
// importing this same primitive via `tasks/execution/WindowRotation`
// contradicted that. See `ServerIsolationLock.ts`'s doc comment for the full
// reasoning behind the move.
import { ensureSessionWithLock, type ServerIsolationLock } from '../servers/ServerIsolationLock';
import type { KeyedMutex } from '../../shared/keyedMutex';
import { rejectQualifiedBranchInput } from '../git/assertSafeGitArgs';
import type { RepoDiscoveryService } from '../git/RepoDiscoveryService';
import { normalizeRemoteUrl } from '../git/parseRemoteUrl';
import { urlHasEmbeddedCredentials } from '../git/urlHasEmbeddedCredentials';
import { sanitizeDiscoveredRemoteUrl } from '../git/sanitizeDiscoveredRemoteUrl';

// ─── Types ───

export interface ProjectsRouteOptions {
  projectRepo: IProjectRepository;
  projectServerRepo: IProjectServerRepository;
  taskRepo: ITaskRepository;
  gitProvider: GitProviderService;
  tmux: TmuxClient;
  serverRepo: IServerRepository;
  projectSecretRepo: SqliteProjectSecretRepository;
  /** Issue #28 Phase A後半: import-issue is a task-origination path too — see TaskOriginationService's own doc comment. */
  originationService: TaskOriginationService;
  // Issue #29 review (10th pass), Critical finding 1: the SAME per-server-name
  // mutex `modules/servers/routes.ts`'s PUT handler, `modules/tmux/routes/
  // sessions.ts`'s manual session/window/pane routes, and task-window
  // (re)creation already serialize the isolation false->true transition
  // against (see that mutex's own doc comment) — required here too, so this
  // route's project-session bootstrap can never build env from a `server`
  // row a concurrent transition has already superseded. See
  // ServerIsolationLock's doc comment in tasks/execution/WindowRotation.ts.
  serverIsolationMutex: KeyedMutex;
  repoDiscovery: RepoDiscoveryService;
}

// ─── Plugin ───

const projectsRoutes: FastifyPluginCallback<ProjectsRouteOptions> = (fastify, opts, done) => {
  const { projectRepo, projectServerRepo, taskRepo, gitProvider, tmux, serverRepo, projectSecretRepo, originationService, serverIsolationMutex, repoDiscovery } = opts;
  const serverIsolationLock: ServerIsolationLock = { serverIsolationMutex, serverRepo };
  const SECRET_NAME_PATTERN = /^[A-Z0-9_]{1,64}$/;

  // ── GET /api/projects ──
  fastify.get('/api/projects', async () => {
    return projectRepo.findAll();
  });

  // ── POST /api/projects ──
  fastify.post('/api/projects', async (request, reply) => {
    const { name, slug, description, sidekick_prompt } = request.body as {
      name?: string;
      slug?: string;
      description?: string;
      sidekick_prompt?: string;
    };
    if (!name) return reply.status(400).send({ error: 'Name required' });
    const finalSlug = slug?.trim() || name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'project';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(finalSlug))
      return reply.status(400).send({ error: 'Slug must contain only lowercase letters, numbers, and hyphens' });
    try {
      const id = projectRepo.create(name, finalSlug, description, sidekick_prompt);
      return { ok: true, id };
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── GET /api/projects/:id ──
  fastify.get<{ Params: { id: string } }>(
    '/api/projects/:id',
    async (request, reply) => {
      const p = projectRepo.findById(parseInt(request.params.id, 10));
      if (!p) return reply.status(404).send({ error: 'Project not found' });
      return p;
    },
  );

  // ── PUT /api/projects/:id ──
  fastify.put<{ Params: { id: string } }>(
    '/api/projects/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const existing = projectRepo.findById(id);
      if (!existing) return reply.status(404).send({ error: 'Project not found' });
      const { name, slug, description, repository_url, default_branch, sidekick_prompt, icon, color, default_unit_id } = request.body as {
        name?: string;
        slug?: string;
        description?: string;
        repository_url?: string;
        default_branch?: string;
        sidekick_prompt?: string;
        icon?: string | null;
        color?: string | null;
        default_unit_id?: number | null;
      };
      if (slug !== undefined) {
        const trimmed = slug.trim();
        if (!trimmed || !/^[a-z0-9][a-z0-9-]*$/.test(trimmed))
          return reply.status(400).send({ error: 'Slug must contain only lowercase letters, numbers, and hyphens' });
      }
      // Same input-boundary guard task base_branch/branch/target_branch get
      // (`validateGitFields` in tasks/routes.ts): a project's `default_branch`
      // feeds the exact same `resolveBaseBranch`/`canonicalizeBaseBranch`
      // chain (TaskExecutionEnv.ts) whenever a task doesn't override it, so
      // it needs the same rejection of new `refs/...`/`origin/...` input
      // (Issue #87 third-party review, 11th round, Important finding 1).
      // Empty string clears the field (falls back to 'main' downstream) and
      // is intentionally exempt, same as the task-side check.
      // Issue #87 14th-round review, Minor finding 3: the destructured
      // `default_branch?: string` annotation above is a compile-time
      // assertion only — a JSON body can still send a non-string (e.g.
      // `123` or `true`), which is truthy and reaches
      // `rejectQualifiedBranchInput`'s `value.startsWith(...)` call
      // uncaught, turning a validation failure into a 500. Reject
      // non-string, non-nullish values with 400 before that call, matching
      // `validateGitFields`'s `typeof v !== 'string'` guard in
      // tasks/routes.ts.
      if (default_branch !== undefined && default_branch !== null && typeof default_branch !== 'string') {
        return reply.status(400).send({ error: 'Invalid default_branch: must be a string' });
      }
      if (default_branch) {
        const reason = rejectQualifiedBranchInput(default_branch);
        if (reason) return reply.status(400).send({ error: `Invalid default_branch: ${reason}` });
      }
      try {
        projectRepo.update(id, {
          name: name || existing.name,
          slug: slug !== undefined ? slug.trim() : existing.slug,
          description: description !== undefined ? description : existing.description,
          repositoryUrl:
            repository_url !== undefined ? repository_url : existing.repositoryUrl,
          defaultBranch:
            default_branch !== undefined ? default_branch : existing.defaultBranch,
          sidekickPrompt:
            sidekick_prompt !== undefined ? sidekick_prompt : existing.sidekickPrompt,
          icon: icon !== undefined ? icon : existing.icon,
          color: color !== undefined ? color : existing.color,
          defaultUnitId:
            default_unit_id !== undefined ? default_unit_id : existing.defaultUnitId,
        });
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── DELETE /api/projects/:id ──
  fastify.delete<{ Params: { id: string } }>(
    '/api/projects/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!projectRepo.findById(id))
        return reply.status(404).send({ error: 'Project not found' });
      projectRepo.delete(id);
      return { ok: true };
    },
  );

  // ── POST /api/projects/:id/repositories ──
  fastify.post<{ Params: { id: string } }>(
    '/api/projects/:id/repositories',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!projectRepo.findById(id))
        return reply.status(404).send({ error: 'Project not found' });
      const { url, name, provider, owner, repo_name, token } = request.body as {
        url?: string; name?: string; provider?: string; owner?: string; repo_name?: string; token?: string;
      };
      if (!url) return reply.status(400).send({ error: 'URL required' });
      const repoId = projectRepo.addRepository(
        id, url, name,
        (provider as RepositoryProvider) || 'github',
        owner, repo_name, token,
      );
      return { ok: true, id: repoId };
    },
  );

  // ── DELETE /api/projects/:id/repositories/:rid ──
  fastify.delete<{ Params: { id: string; rid: string } }>(
    '/api/projects/:id/repositories/:rid',
    async (request) => {
      projectRepo.removeRepository(
        parseInt(request.params.rid, 10),
        parseInt(request.params.id, 10),
      );
      return { ok: true };
    },
  );

  // ── GET /api/projects/:id/servers ──
  fastify.get<{ Params: { id: string } }>(
    '/api/projects/:id/servers',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!projectRepo.findById(id))
        return reply.status(404).send({ error: 'Project not found' });
      return projectServerRepo.findByProject(id);
    },
  );

  // ── PUT /api/projects/:id/servers/:serverName ──
  fastify.put<{ Params: { id: string; serverName: string } }>(
    '/api/projects/:id/servers/:serverName',
    async (request, reply) => {
      const projectId = parseInt(request.params.id, 10);
      const serverName = request.params.serverName;
      const project = projectRepo.findById(projectId);
      if (!project)
        return reply.status(404).send({ error: 'Project not found' });
      const body = (request.body ?? {}) as {
        working_directory?: string | null;
        branch?: string | null;
        tmux_session?: string | null;
        input_policy?: string;
        distribute_code?: boolean;
        distribution_repository_id?: number | null;
      };
      // tmux_session semantics: key present with null/empty resets to the default
      // ('azito'); key present with a value sets it (trimmed); key absent preserves
      // the existing value (default for a brand-new row).
      const existingRow = projectServerRepo.find(projectId, serverName);
      const tmuxSession = 'tmux_session' in body
        ? (body.tmux_session?.trim() || 'azito')
        : (existingRow?.tmuxSession ?? 'azito');
      // working_directory/branch use the same "key absent preserves, key
      // present (incl. explicit null) sets" semantics as tmux_session/
      // input_policy below — a client that PUTs only { input_policy } must
      // not silently wipe the other fields. working_directory in particular
      // is the containment boundary (PathContainment.ts): losing it isn't
      // just a lost setting, it's a lost security boundary (Issue #328
      // review). Previously this fell through to `body.xxx ?? null`, which
      // treated "key omitted" the same as "key explicitly null".
      const workingDirectory = 'working_directory' in body
        ? (body.working_directory ?? null)
        : (existingRow?.workingDirectory ?? null);
      const branch = 'branch' in body
        ? (body.branch ?? null)
        : (existingRow?.branch ?? null);
      // Same input-boundary guard as the project's own `default_branch`
      // above and task base_branch/branch/target_branch (validateGitFields
      // in tasks/routes.ts) — this row's `branch` feeds the same
      // `resolveBaseBranch`/`canonicalizeBaseBranch` chain (Issue #87
      // third-party review, 11th round, Important finding 1). Only checked
      // when the key is present AND non-empty (matches the "key absent
      // preserves, explicit null/'' clears" semantics this handler already
      // uses for this field).
      // Issue #87 14th-round review, Minor finding 3: `body.branch` above is
      // typed `string | null` only at compile time — a JSON body can still
      // send e.g. `true`, which is truthy and would otherwise reach
      // `rejectQualifiedBranchInput`'s `value.startsWith(...)` call
      // uncaught, turning a validation failure into a 500.
      if ('branch' in body && body.branch !== undefined && body.branch !== null && typeof body.branch !== 'string') {
        return reply.status(400).send({ error: 'Invalid branch: must be a string' });
      }
      if ('branch' in body && body.branch) {
        const reason = rejectQualifiedBranchInput(body.branch);
        if (reason) return reply.status(400).send({ error: `Invalid branch: ${reason}` });
      }
      // Issue #29 Step 3a: 'allow' is now selectable, but ONLY declaratively
      // for a server that has declared isolation intent — the real safety
      // property (verified, time-bounded, scoped-auth-gated) is enforced at
      // RUN TIME by resolveEffectiveInputPolicy() (projects/ProjectServer.ts),
      // not here. This check only prevents an obviously-wrong configuration
      // (declaring 'allow' against a server that was never even INTENDED to
      // be isolated) from being saved at all; it deliberately does not
      // require `isolationVerifiedAt` to be current — an operator may
      // legitimately configure 'allow' before ever running the doctor, and
      // the run-time gate will simply keep it degraded to 'manual-approval'
      // until verification catches up.
      if (body.input_policy === 'allow') {
        const targetServer = serverRepo.findByName(serverName);
        if (!targetServer?.isolationIntent) {
          return reply.status(400).send({ error: 'input_policy_allow_requires_isolation', message: "input_policy 'allow' requires the server to have isolation intent declared first" });
        }
      }
      if (body.input_policy !== undefined && body.input_policy !== 'deny' && body.input_policy !== 'manual-approval' && body.input_policy !== 'allow') {
        return reply.status(400).send({ error: "input_policy must be 'deny', 'manual-approval', or 'allow'" });
      }
      // resolveInputPolicy (projects/ProjectServer.ts) is the single place
      // that applies the "unset -> manual-approval" default (Issue #29 Step
      // 0 — this used to be a second, independently-hardcoded copy of the
      // same literal).
      const inputPolicy = (body.input_policy as 'deny' | 'manual-approval' | 'allow' | undefined) ?? resolveInputPolicy(existingRow);
      // distribute_code: same "key absent preserves, key present sets"
      // semantics as working_directory/branch/tmux_session above — a client
      // that PUTs only { input_policy } must not silently reset this too.
      // Meaningless for a `local` server (hub itself; ExecuteTaskUseCase
      // excludes `local` from the distribution gate outright), but that
      // exclusion lives there, not here — this endpoint just stores the flag.
      // Validated (not `!!body.distribute_code`) the same way input_policy
      // is validated above: a declared boolean contract must reject
      // non-boolean JSON (e.g. `"false"`, `{}`, `1`) rather than silently
      // coercing it (review finding, Issue #87).
      if (body.distribute_code !== undefined && typeof body.distribute_code !== 'boolean') {
        return reply.status(400).send({ error: 'distribute_code must be a boolean' });
      }
      const requestedDistributeCode = 'distribute_code' in body
        ? (body.distribute_code as boolean)
        : (existingRow?.distributeCode ?? false);
      // Normalize (not reject) `distribute_code: true` against a `local`
      // target server (Issue #87 review finding, Minor 3): the frontend
      // form is expected to keep this client-side-consistent already, but
      // a stale/anomalous DB row (e.g. saved before this normalization
      // existed) or a direct API caller could still send `true` for
      // `local`. `local` IS the hub itself — "distributing" to it is
      // structurally meaningless — so rejecting with 400 would just make
      // an otherwise-valid PUT (working_directory/branch/etc.) fail for a
      // field the caller may not even know is wrong; silently coercing to
      // `false` here keeps the save that already-existing "unsaid fields
      // preserve" contract elsewhere in this handler and prevents the
      // "配信対象" badge from ever showing for a server that
      // ExecuteTaskUseCase already unconditionally excludes from
      // distribution.
      const targetServerType = serverRepo.findByName(serverName)?.type;
      const distributeCode = targetServerType === 'local' ? false : requestedDistributeCode;
      // distribution_repository_id: same "key absent preserves, key present
      // (incl. explicit null) sets" semantics as working_directory/branch/
      // distribute_code above — a client that PUTs only { distribute_code }
      // must not silently wipe an already-configured distribution target.
      // Validated the same way distribute_code is validated above: a
      // declared `number | null` contract must reject other JSON types
      // (e.g. `"5"`, `{}`, `true`) rather than silently coercing them.
      if (
        body.distribution_repository_id !== undefined &&
        body.distribution_repository_id !== null &&
        typeof body.distribution_repository_id !== 'number'
      ) {
        return reply.status(400).send({ error: 'distribution_repository_id must be a number or null' });
      }
      const requestedDistributionRepositoryId = 'distribution_repository_id' in body
        ? (body.distribution_repository_id ?? null)
        : (existingRow?.distributionRepositoryId ?? null);
      // A distribution target must belong to THIS project — otherwise a
      // caller could point distribution at another project's repository
      // (and, since hub-代行 distribution uses the repository's own stored
      // token, effectively exfiltrate that other project's git credentials
      // onto a server it has no relationship to).
      if (requestedDistributionRepositoryId !== null && !project.repositories.some((r) => r.id === requestedDistributionRepositoryId)) {
        return reply.status(400).send({ error: 'distribution_repository_id must reference a repository belonging to this project' });
      }
      projectServerRepo.upsert({
        projectId,
        serverName,
        workingDirectory,
        branch,
        tmuxSession,
        inputPolicy,
        distributeCode,
        distributionRepositoryId: requestedDistributionRepositoryId,
      });

      let sessionCreated = false;
      const srv = serverRepo.findByName(serverName);
      if (srv) {
        try {
          // No token in extraEnv (Issue #28 third-party review finding,
          // Critical): `tmux new-session -e` sets the SESSION's own
          // environment, not just this call's window — every window
          // created later in this session (including a task's, via
          // ExecuteTaskUseCase/TaskRestoreService's `createWindow` into
          // this exact `project.slug` session) would inherit
          // AZITO_UI_TOKEN from here and bypass scoped task-token auth
          // entirely, with no reference anywhere to this createSession
          // call to explain why (verified empirically against tmux 3.4:
          // a session-level var set via `-e` on `new-session` propagates
          // to windows added afterwards with `new-window`, even with no
          // `-e` of their own). This first window is an unmanaged
          // generated-name placeholder nobody uses directly (same as
          // ExecuteTaskUseCase's own throwaway-session bootstrap window),
          // so it has no legitimate need for the token either. Routed
          // through `ensureSessionWithLock`'s `isolationMaskForServer`,
          // not a bare `{}` and not `uiTokenEnvForServer` (Issue #29
          // review, 11th pass, Critical finding 1 — this is a task-owned
          // session, so it must never inject the operator UI token the
          // way `uiTokenEnvForServer` does): an isolated server's pane
          // inherits whatever process env the tmux SERVER itself runs
          // under regardless of what this call's own `extraEnv` passes,
          // so the explicit mask is still required here.
          //
          // Routed through ensureSessionWithLock (Issue #29 review, 10th
          // pass, Critical finding 1): the existence check AND the
          // createSession call both now run inside serverIsolationLock,
          // against a server row re-read only once the lock is held —
          // never against `srv`, resolved just above with no lock at all,
          // which a concurrent isolation PUT may have already superseded.
          //
          // `enforceSnapshot: false` (Issue #29 review, 12th pass, Critical
          // finding 1): every OTHER `ensureSessionWithLock`/`createRotatedWindow`
          // call site sits downstream of a task execution-approval gate
          // (`enforceExecutionGate`) and resource/containment checks run
          // against the caller's own `server` snapshot — for those, a
          // refetch that disagrees with that snapshot on a security field
          // must abort (the whole point of this finding). This bootstrap
          // call has no such approval boundary to protect: it is a
          // best-effort (see the surrounding `catch` below), unauthenticated
          // "does this project's session exist yet" convenience check that
          // runs on its own, unrelated to any task's execute/resume path —
          // there is nothing here that a stale `srv` could have already
          // approved that the fresh row could contradict. Keeping the old
          // "adopt whichever row is current" behavior is correct.
          const sessionResult = await ensureSessionWithLock(tmux, serverIsolationLock, srv, project.slug, false);
          sessionCreated = sessionResult.created;
        } catch {
          // tmux session creation is best-effort
        }
      }

      return { ok: true, sessionCreated };
    },
  );

  // ── DELETE /api/projects/:id/servers/:serverName ──
  fastify.delete<{ Params: { id: string; serverName: string } }>(
    '/api/projects/:id/servers/:serverName',
    async (request) => {
      projectServerRepo.remove(
        parseInt(request.params.id, 10),
        request.params.serverName,
      );
      return { ok: true };
    },
  );

  // ── Helper: resolve repo for remote-issues endpoints ──
  function resolveRepo(repoId: number, reply: any) {
    const repo = projectRepo.findRepositoryById(repoId);
    if (!repo || !repo.owner || !repo.repoName) {
      reply.status(400).send({ error: 'Repository with owner/repo_name required' });
      return null;
    }
    if (repo.provider !== 'github' && repo.provider !== 'gitlab') {
      reply.status(400).send({ error: 'Only GitHub and GitLab repositories are supported' });
      return null;
    }
    return repo;
  }

  // ── GET /api/projects/:id/remote-issues ──
  fastify.get<{ Params: { id: string }; Querystring: { repo_id?: string; state?: string; page?: string; per_page?: string; fresh?: string } }>(
    '/api/projects/:id/remote-issues',
    async (request, reply) => {
      const project = projectRepo.findById(parseInt(request.params.id, 10));
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      const repoId = parseInt(request.query.repo_id || '', 10);
      if (!repoId) return reply.status(400).send({ error: 'repo_id required' });
      const repo = resolveRepo(repoId, reply);
      if (!repo) return;
      try {
        const result = await gitProvider.listIssues(repo, {
          state: (request.query.state as 'open' | 'closed' | 'all') || 'open',
          page: parseInt(request.query.page || '1', 10),
          perPage: parseInt(request.query.per_page || '20', 10),
          fresh: request.query.fresh === '1',
        });
        return result;
      } catch (err: unknown) {
        return reply.status(502).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/projects/:id/remote-issues/search ──
  fastify.get<{ Params: { id: string }; Querystring: { repo_id?: string; q?: string } }>(
    '/api/projects/:id/remote-issues/search',
    async (request, reply) => {
      const project = projectRepo.findById(parseInt(request.params.id, 10));
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      const repoId = parseInt(request.query.repo_id || '', 10);
      if (!repoId) return reply.status(400).send({ error: 'repo_id required' });
      const repo = resolveRepo(repoId, reply);
      if (!repo) return;
      const q = request.query.q || '';
      if (!q) return reply.status(400).send({ error: 'q (search query) required' });
      try {
        const issues = await gitProvider.searchIssues(repo, q);
        return { issues };
      } catch (err: unknown) {
        return reply.status(502).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/projects/:id/remote-issues/:number ──
  fastify.get<{ Params: { id: string; number: string }; Querystring: { repo_id?: string } }>(
    '/api/projects/:id/remote-issues/:number',
    async (request, reply) => {
      const project = projectRepo.findById(parseInt(request.params.id, 10));
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      const repoId = parseInt(request.query.repo_id || '', 10);
      if (!repoId) return reply.status(400).send({ error: 'repo_id required' });
      const repo = resolveRepo(repoId, reply);
      if (!repo) return;
      const issueNumber = parseInt(request.params.number, 10);
      if (!issueNumber) return reply.status(400).send({ error: 'Invalid issue number' });
      try {
        const issue = await gitProvider.getIssue(repo, issueNumber);
        return issue;
      } catch (err: unknown) {
        return reply.status(502).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/projects/:id/remote-pulls ──
  fastify.get<{ Params: { id: string }; Querystring: { repo_id?: string; state?: string; page?: string; per_page?: string; fresh?: string } }>(
    '/api/projects/:id/remote-pulls',
    async (request, reply) => {
      const project = projectRepo.findById(parseInt(request.params.id, 10));
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      const repoId = parseInt(request.query.repo_id || '', 10);
      if (!repoId) return reply.status(400).send({ error: 'repo_id required' });
      const repo = resolveRepo(repoId, reply);
      if (!repo) return;
      try {
        const result = await gitProvider.listPullRequests(repo, {
          state: (request.query.state as 'open' | 'closed' | 'all') || 'open',
          page: parseInt(request.query.page || '1', 10),
          perPage: parseInt(request.query.per_page || '20', 10),
          fresh: request.query.fresh === '1',
        });
        return result;
      } catch (err: unknown) {
        return reply.status(502).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/projects/:id/remote-pulls/:number ──
  fastify.get<{ Params: { id: string; number: string }; Querystring: { repo_id?: string } }>(
    '/api/projects/:id/remote-pulls/:number',
    async (request, reply) => {
      const project = projectRepo.findById(parseInt(request.params.id, 10));
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      const repoId = parseInt(request.query.repo_id || '', 10);
      if (!repoId) return reply.status(400).send({ error: 'repo_id required' });
      const repo = resolveRepo(repoId, reply);
      if (!repo) return;
      const prNumber = parseInt(request.params.number, 10);
      if (!prNumber) return reply.status(400).send({ error: 'Invalid pull request number' });
      try {
        const pr = await gitProvider.getPullRequest(repo, prNumber);
        return pr;
      } catch (err: unknown) {
        return reply.status(502).send({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/projects/:id/import-issue ──
  fastify.post<{ Params: { id: string } }>(
    '/api/projects/:id/import-issue',
    async (request, reply) => {
      const projectId = parseInt(request.params.id, 10);
      const project = projectRepo.findById(projectId);
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      const { repo_id, issue_number, unit_id, self_review_max_attempts } = request.body as {
        repo_id?: number; issue_number?: number; unit_id?: number;
        self_review_max_attempts?: number;
      };
      if (!repo_id || !issue_number || !unit_id)
        return reply.status(400).send({ error: 'repo_id, issue_number, unit_id required' });
      const repo = resolveRepo(repo_id, reply);
      if (!repo) return;
      try {
        const issue = await gitProvider.getIssue(repo, issue_number);
        const source = repo.provider === 'gitlab' ? 'gitlab' : 'github';
        // Issue body content comes straight from an external tracker with no
        // human review yet — TaskOriginationService derives `inputTrust` from
        // `origin.kind` ('operator', since this route is operator-only by
        // omission — no `config.auth` declared) AND `source` together (Issue
        // #28 design v3 §5's fail-safe reversal of the original Issue #328
        // rule): 'github'/'gitlab' still lands on 'untrusted' regardless of
        // the operator origin. The execution gate (ExecutionGate.ts) treats
        // this the same as any GitHub/GitLab-sourced task regardless of what
        // `source`/`source_ref` end up being edited to later (Issue #328).
        const taskId = originationService.create({
          projectId,
          unitId: unit_id,
          serverName: null,
          title: issue.title,
          description: issue.body || null,
          status: 'open',
          currentPhase: null,
          selfReviewCount: 0,
          priority: 0,
          tmuxWindow: null,
          selfReviewMaxAttempts: self_review_max_attempts ?? null,
          requirePlanApproval: true,
          source,
          sourceRef: `${repo.owner}/${repo.repoName}#${issue_number}`,
          worktreePath: null,
          worktreeBranch: null,
          baseBranch: null,
          targetBranch: null,
          skipPr: false,
          workingDirectory: null,
          branch: null,
          planMarkdown: null,
          pendingQuestions: null,
          changedFiles: null,
          summaryJson: null,
          prUrl: null,
          agentSessionId: null,
          reviewSubagent: null,
          implementSubagent: null,
          sleepAfterPush: null,
          executionApprovedFingerprintHash: null,
          pendingOperation: null,
          pendingOperationWindowId: null,
          pendingOperationPriorStatus: null,
        }, originFromPrincipal(request.principal), request.principal ?? OPERATOR_PRINCIPAL);
        return { ok: true, taskId, issue: { number: issue.number, title: issue.title } };
      } catch (err: unknown) {
        return reply.status(502).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/projects/:id/secrets ──
  fastify.get<{ Params: { id: string } }>('/api/projects/:id/secrets', async (request, reply) => {
    const project = projectRepo.findById(Number(request.params.id));
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return projectSecretRepo.findByProject(project.id);
  });

  // ── POST /api/projects/:id/secrets ──
  fastify.post<{ Params: { id: string }; Body: { name: string; value: string } }>('/api/projects/:id/secrets', async (request, reply) => {
    const project = projectRepo.findById(Number(request.params.id));
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const body = request.body as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    const value = typeof body.value === 'string' ? body.value : '';
    if (!name || !SECRET_NAME_PATTERN.test(name)) {
      return reply.status(400).send({ error: 'Invalid name: must match /^[A-Z0-9_]{1,64}$/' });
    }
    if (!value || value.length > 4096) {
      return reply.status(400).send({ error: 'Invalid value: must be 1-4096 characters' });
    }
    projectSecretRepo.upsert(project.id, name, value);
    return { ok: true };
  });

  // ── DELETE /api/projects/:id/secrets/:name ──
  fastify.delete<{ Params: { id: string; name: string } }>('/api/projects/:id/secrets/:name', async (request, reply) => {
    const project = projectRepo.findById(Number(request.params.id));
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const deleted = projectSecretRepo.remove(project.id, request.params.name);
    if (!deleted) return reply.status(404).send({ error: 'Secret not found' });
    return { ok: true };
  });

  // ── GET /api/projects/:id/servers/:serverName/discover-repositories ──
  fastify.get<{ Params: { id: string; serverName: string } }>(
    '/api/projects/:id/servers/:serverName/discover-repositories',
    async (request, reply) => {
      const projectId = parseInt(request.params.id, 10);
      const project = projectRepo.findById(projectId);
      if (!project) return reply.status(404).send({ error: 'Project not found' });

      const ps = projectServerRepo.find(projectId, request.params.serverName);
      if (!ps?.workingDirectory) {
        return reply.status(400).send({ error: 'Working directory not configured for this server environment' });
      }

      const srv = serverRepo.findByName(request.params.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      let discovered;
      try {
        discovered = await repoDiscovery.discover(srv, ps.workingDirectory);
      } catch (err) {
        // A scan that could not run must never be reported the same way as
        // a scan that found nothing (Issue #19 review, Important finding 5)
        // — surface it as an error, not an empty `repositories: []` list.
        // The thrown message may embed the raw working directory path but
        // never a remote URL (discover() fails before any `git remote -v`
        // output is read), so it is safe to log/return as-is.
        fastify.log.warn({ err, serverName: request.params.serverName }, 'repository discovery scan failed');
        return reply.status(502).send({ error: 'Failed to scan the working directory for git repositories' });
      }

      const existingUrls = new Set(
        (project.repositories || [])
          .map((r) => sanitizeDiscoveredRemoteUrl(r.url))
          .filter((u): u is string => u !== null)
          .map(normalizeRemoteUrl),
      );

      // Discovered remote URLs come straight from the server's git config
      // and may embed credentials (`https://user:token@host/repo.git`) —
      // strip them before this ever reaches the browser or the (plaintext)
      // `project_repositories.url` column (Issue #19 review, Important
      // finding 1). This must stay a URL `git clone` can actually use, so
      // it goes through `sanitizeDiscoveredRemoteUrl` (strips real
      // credentials only) rather than `redactGitUrlCredentials` (a
      // log-only helper that also drops the non-secret SSH `user@`
      // prefix and replaces anything it can't parse, e.g. a local-path
      // remote, with a fixed placeholder — Issue #19 later review round,
      // Important finding 1). Dedup against `existingUrls` uses the same
      // sanitized form so a credentialed vs. sanitized URL for the same
      // repo still matches. A remote that `sanitizeDiscoveredRemoteUrl`
      // cannot clean (structurally malformed) comes back as `null` and is
      // dropped from the response entirely rather than shown as a
      // placeholder string (Issue #19 3rd review round, Nit finding 2).
      const repositories = discovered.map((repo) => ({
        relativePath: repo.relativePath,
        absolutePath: repo.absolutePath,
        remotes: repo.remotes
          .map((remote) => {
            const safeUrl = sanitizeDiscoveredRemoteUrl(remote.url);
            if (safeUrl === null) return null;
            return {
              name: remote.name,
              url: safeUrl,
              provider: remote.parsed.provider,
              owner: remote.parsed.owner,
              repoName: remote.parsed.repoName,
              alreadyRegistered: existingUrls.has(normalizeRemoteUrl(safeUrl)),
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null),
      }));

      return { repositories };
    },
  );

  // ── POST /api/projects/:id/repositories/bulk ──
  fastify.post<{ Params: { id: string } }>(
    '/api/projects/:id/repositories/bulk',
    async (request, reply) => {
      const projectId = parseInt(request.params.id, 10);
      const project = projectRepo.findById(projectId);
      if (!project) return reply.status(404).send({ error: 'Project not found' });

      const body = request.body as Record<string, unknown>;
      const repositories = body.repositories;
      if (!Array.isArray(repositories)) {
        return reply.status(400).send({ error: 'repositories array required' });
      }

      // Reject the whole batch outright if any entry carries embedded
      // credentials — this endpoint writes into the plaintext
      // `project_repositories.url` column, and credentials belong only in
      // the existing encrypted `token` column (Important finding 1).
      for (const repo of repositories) {
        const url = typeof (repo as { url?: unknown })?.url === 'string' ? (repo as { url: string }).url.trim() : '';
        if (url && urlHasEmbeddedCredentials(url)) {
          return reply.status(400).send({ error: 'Repository URLs must not contain embedded credentials; use the token field instead' });
        }
      }

      const existingUrls = new Set(
        (project.repositories || [])
          .map((r) => sanitizeDiscoveredRemoteUrl(r.url))
          .filter((u): u is string => u !== null)
          .map(normalizeRemoteUrl),
      );

      let added = 0;
      let skipped = 0;
      for (const repo of repositories) {
        const rawUrl = typeof repo?.url === 'string' ? repo.url.trim() : '';
        if (!rawUrl) { skipped++; continue; }
        // Query-string/fragment credentials (`?token=...`, `#access_token=...`)
        // are not caught by the urlHasEmbeddedCredentials() rejection above
        // (it only inspects userinfo) — route every URL through the same
        // sanitizer used for discovered remotes before it reaches this
        // plaintext column (Issue #19 later review round, Important finding 1).
        const url = sanitizeDiscoveredRemoteUrl(rawUrl);
        // A structurally malformed scheme:// value cannot be sanitized and
        // comes back as `null` — reject just this entry (via the existing
        // `skipped` counter, matching how an empty url is already handled
        // above) rather than failing the whole batch or storing a
        // placeholder string as if it were a real, added repository
        // (Issue #19 3rd review round, Nit finding 2).
        if (url === null) { skipped++; continue; }
        if (existingUrls.has(normalizeRemoteUrl(url))) { skipped++; continue; }
        const name = typeof repo.name === 'string' ? repo.name : undefined;
        const provider = typeof repo.provider === 'string' ? repo.provider : undefined;
        const owner = typeof repo.owner === 'string' ? repo.owner : undefined;
        const repoName = typeof repo.repoName === 'string' ? repo.repoName : undefined;
        projectRepo.addRepository(
          projectId,
          url,
          name,
          (provider as RepositoryProvider) || 'other',
          owner,
          repoName,
        );
        existingUrls.add(normalizeRemoteUrl(url));
        added++;
      }

      return { added, skipped };
    },
  );

  done();
};

export default projectsRoutes;
