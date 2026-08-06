import type { FastifyPluginCallback } from 'fastify';
import type { IProjectRepository, RepositoryProvider } from './Project';
import type { IProjectServerRepository } from './ProjectServer';
import type { ITaskRepository } from '../tasks/Task';
import type { GitProviderService } from '../git/providers/GitProviderService';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { IServerRepository } from '../servers/Server';
import type { SqliteProjectSecretRepository } from './SqliteProjectSecretRepository';

// ─── Types ───

export interface ProjectsRouteOptions {
  projectRepo: IProjectRepository;
  projectServerRepo: IProjectServerRepository;
  taskRepo: ITaskRepository;
  gitProvider: GitProviderService;
  tmux: TmuxClient;
  serverRepo: IServerRepository;
  projectSecretRepo: SqliteProjectSecretRepository;
}

// ─── Plugin ───

const projectsRoutes: FastifyPluginCallback<ProjectsRouteOptions> = (fastify, opts, done) => {
  const { projectRepo, projectServerRepo, taskRepo, gitProvider, tmux, serverRepo, projectSecretRepo } = opts;
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
      // 'allow' is rejected here, not just left undocumented: it would skip the
      // execution-approval gate entirely for untrusted tasks, but the isolated
      // execution profile that would make that safe (Issue #328 design doc)
      // doesn't exist yet. Rejecting at the API boundary keeps a misconfigured
      // client from silently granting unattended execution of external input.
      if (body.input_policy === 'allow') {
        return reply.status(400).send({ error: "input_policy 'allow' is not selectable yet (isolated execution profile not implemented)" });
      }
      if (body.input_policy !== undefined && body.input_policy !== 'deny' && body.input_policy !== 'manual-approval') {
        return reply.status(400).send({ error: "input_policy must be 'deny' or 'manual-approval'" });
      }
      const inputPolicy = (body.input_policy as 'deny' | 'manual-approval' | undefined) ?? existingRow?.inputPolicy ?? 'manual-approval';
      projectServerRepo.upsert({
        projectId,
        serverName,
        workingDirectory,
        branch,
        tmuxSession,
        inputPolicy,
      });

      let sessionCreated = false;
      const srv = serverRepo.findByName(serverName);
      if (srv) {
        try {
          const sessions = await tmux.listSessions(srv);
          const exists = sessions.some((s) => s.name === project.slug);
          if (!exists) {
            await tmux.createSession(srv, project.slug, {});
            sessionCreated = true;
          }
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
        const taskId = taskRepo.create({
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
          // Issue body content comes straight from an external tracker with no
          // human review yet — the execution gate (ExecutionGate.ts) treats
          // this the same as a GitHub/GitLab-sourced task regardless of what
          // `source`/`source_ref` end up being edited to later (Issue #328).
          inputTrust: 'untrusted',
          executionApprovedFingerprintHash: null,
        });
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

  done();
};

export default projectsRoutes;
