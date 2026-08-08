import type { FastifyPluginCallback } from 'fastify';
import type { SidekickPackageService, SidekickScriptInput, UpdateSidekickInput } from './SidekickPackageService';
import type { ITaskPromptVarsResolver } from './ITaskPromptVarsResolver';
import type { UnitTypeLoader } from './UnitTypeLoader';
import { renderSidekickBody } from './renderSidekickBody';
import { loadPromptModules } from '../prompt/PromptModuleLoader';
import type { RouteAuthRequirement } from '../../shared/auth/routeAuth';

// ─── Types ───

export interface SidekicksRouteOptions {
  sidekickService: SidekickPackageService;
  taskPromptVarsResolver: ITaskPromptVarsResolver;
  unitTypeLoader: UnitTypeLoader;
  /**
   * Auth requirement for GET /api/sidekicks/:name (Issue #28 design v3 §4:
   * task principal allowed only for render=1 + task_id=self + a Sidekick
   * assigned to that task's Unit). Built in buildServer.ts because the
   * condition needs cross-module task/unit lookups this mid-layer module
   * must not depend on directly (see .dependency-cruiser.cjs).
   */
  detailAuth: RouteAuthRequirement;
  /**
   * Auth requirement for GET /api/sidekicks (list). A task principal is
   * always let through the gate; the response is then narrowed to that
   * task's Unit's assigned Sidekicks via `resolveAssignedSidekickNames`
   * (Issue #28 third-party review fix 1+2).
   */
  listAuth: RouteAuthRequirement;
  /**
   * Resolves the set of Sidekick names assigned to a task's Unit's phases
   * (built in buildServer.ts — see `sidekickDetailAuth`'s comment for why
   * this cross-module lookup can't live in this mid-layer module).
   */
  resolveAssignedSidekickNames: (taskId: number) => Set<string>;
}

// ─── Helpers ───

function isNotFoundError(message: string): boolean {
  return message.includes('not found');
}

/** body が JSON オブジェクトでない（null / 配列 / プリミティブ / 欠落）リクエストを弾く。 */
function asObjectBody(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/** scripts 入力の構造検証（各要素が {filename: string, content: string} であること）。 */
function parseScriptsInput(raw: unknown): SidekickScriptInput[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error('scripts must be an array');
  return raw.map((item, i) => {
    const obj = asObjectBody(item);
    if (!obj || typeof obj.filename !== 'string' || typeof obj.content !== 'string') {
      throw new Error(`scripts[${i}] must be an object with string "filename" and "content"`);
    }
    return { filename: obj.filename, content: obj.content };
  });
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

/** tags 入力の構造検証（文字列配列であること）。中身の形式検証（kebab-case 等）は service 側で行う。 */
function parseTagsInput(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error('tags must be an array of strings');
  return raw.map((t, i) => {
    if (typeof t !== 'string') throw new Error(`tags[${i}] must be a string`);
    return t;
  });
}

// ─── Plugin ───

const sidekicksRoutes: FastifyPluginCallback<SidekicksRouteOptions> = (fastify, opts, done) => {
  const { sidekickService, taskPromptVarsResolver, detailAuth, listAuth, resolveAssignedSidekickNames } = opts;

  // ── GET /api/sidekicks ── マージ済み一覧（メタ情報のみ、body は含まない）
  // task principal は自タスクの Unit のフェーズに割当済みの Sidekick のみを見る
  // （Issue #28 third-party review fix 1+2）。operator は従来どおり全件。
  fastify.get('/api/sidekicks', { config: { auth: listAuth } }, async (request) => {
    const all = sidekickService.list();
    if (request.principal?.class === 'task' && request.principal.id !== undefined) {
      const assigned = resolveAssignedSidekickNames(request.principal.id);
      return all.filter((pkg) => assigned.has(pkg.name));
    }
    return all;
  });

  // ── GET /api/sidekicks/:name ── 詳細（body 含む）、?render=1 でテンプレート変数展開（Issue #263 Phase 5、azt-sidekick 用）
  fastify.get<{ Params: { name: string }; Querystring: { render?: string; task_id?: string } }>(
    '/api/sidekicks/:name',
    { config: { auth: detailAuth } },
    async (request, reply) => {
      const pkg = sidekickService.getDetail(request.params.name);
      if (!pkg) return reply.status(404).send({ error: 'Sidekick not found' });

      const { render, task_id } = request.query;
      if (render !== '1') return pkg;

      // task_id あり: RenderSkillPromptUseCase と同じ vars で展開（ITaskPromptVarsResolver 経由でコード共有）。
      // {{sidekick.dir}} もタスクの実行サーバー基準で解決する（ssh/agent なら同期を保証、Issue #263 Phase 6）。
      if (task_id) {
        const taskId = parseInt(task_id, 10);
        if (isNaN(taskId)) return reply.status(400).send({ error: 'task_id must be a number' });
        try {
          const vars = taskPromptVarsResolver.resolve(taskId);
          const dir = await taskPromptVarsResolver.resolveDir(taskId, pkg);
          const prompt = renderSidekickBody(pkg, vars, false, dir);
          return { name: pkg.name, tags: pkg.tags, prompt };
        } catch (err: unknown) {
          const message = (err as Error).message;
          if (message.startsWith('Task not found') || message.startsWith('Project not found')) {
            return reply.status(404).send({ error: message });
          }
          return reply.status(500).send({ error: message });
        }
      }

      // task_id なし: {{sidekick.*}}/{{module.*}} のみ展開し、task/project系は keepUnknown で残す
      // （standalone パッケージも task_id なしで render 可能にするため）
      const promptModules = loadPromptModules();
      const prompt = renderSidekickBody(pkg, {
        module: {
          reviewPerspectives: promptModules.reviewPerspectives,
          softwareDesignPrinciples: promptModules.softwareDesignPrinciples,
          uiDesignPrinciples: promptModules.uiDesignPrinciples,
        },
      }, true);
      return { name: pkg.name, tags: pkg.tags, prompt };
    },
  );

  // ── POST /api/sidekicks ── ユーザー層に scaffold 生成
  fastify.post('/api/sidekicks', async (request, reply) => {
    const body = asObjectBody(request.body);
    if (!body) {
      return reply.status(400).send({ error: 'Request body must be a JSON object' });
    }
    if (typeof body.name !== 'string' || typeof body.description !== 'string' || !body.name || !body.description) {
      return reply.status(400).send({ error: 'name and description are required strings' });
    }
    try {
      sidekickService.create({
        name: body.name,
        description: body.description,
        // tags 優先、無ければ後方互換で phase を受ける（service 側で正規化・検証される）
        tags: parseTagsInput(body.tags),
        phase: optionalString(body.phase, 'phase'),
        isDefault: optionalBoolean(body.isDefault, 'isDefault'),
        body: optionalString(body.body, 'body'),
        scripts: parseScriptsInput(body.scripts),
      });
      return reply.status(201).send({ ok: true, name: body.name });
    } catch (err: unknown) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // ── PUT /api/sidekicks/:name ── ユーザー層の SKILL.md 更新（ビルトインは copy-on-write）
  fastify.put<{ Params: { name: string } }>('/api/sidekicks/:name', async (request, reply) => {
    const body = asObjectBody(request.body);
    if (!body) {
      return reply.status(400).send({ error: 'Request body must be a JSON object' });
    }
    try {
      const input: UpdateSidekickInput = {
        description: optionalString(body.description, 'description'),
        tags: parseTagsInput(body.tags),
        phase: optionalString(body.phase, 'phase'),
        isDefault: optionalBoolean(body.isDefault, 'isDefault'),
        body: optionalString(body.body, 'body'),
        scripts: parseScriptsInput(body.scripts),
      };
      sidekickService.update(request.params.name, input);
      return { ok: true };
    } catch (err: unknown) {
      const message = (err as Error).message;
      return reply.status(isNotFoundError(message) ? 404 : 400).send({ error: message });
    }
  });

  // ── DELETE /api/sidekicks/:name ── ユーザー層のみ削除可
  fastify.delete<{ Params: { name: string } }>('/api/sidekicks/:name', async (request, reply) => {
    try {
      sidekickService.remove(request.params.name);
      return { ok: true };
    } catch (err: unknown) {
      const message = (err as Error).message;
      return reply.status(isNotFoundError(message) ? 404 : 400).send({ error: message });
    }
  });

  // ── GET /api/unit-types ── UnitType 一覧
  fastify.get('/api/unit-types', async () => {
    return opts.unitTypeLoader.list();
  });

  done();
};

export default sidekicksRoutes;
