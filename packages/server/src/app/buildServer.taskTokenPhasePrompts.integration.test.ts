import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTokenVerifier } from '../modules/servers/auth/tokenAuth';
import { resolvePrincipal } from '../shared/auth/resolvePrincipal';
import { evaluateRouteAuth } from '../shared/auth/routeAuth';
import { formatTaskToken } from '../shared/auth/taskTokenFormat';
import { UnitTypeLoader } from '../modules/sidekicks/UnitTypeLoader';
import phasePromptsRoutes from '../modules/prompt/routes';
import type { RenderSkillPromptUseCase } from '../modules/prompt/RenderSkillPromptUseCase';
import type { SidekickPackageLoader } from '../modules/sidekicks/SidekickPackageLoader';

/**
 * Issue #28 修正1: harness/skills/azt-<phase> 配下の SKILL.md の curl は
 * `${AZITO_TASK_TOKEN:-$AZITO_UI_TOKEN}` を Authorization ヘッダーに使う
 * (AZITO_SCOPED_AUTH=1 の task ペインには AZITO_UI_TOKEN が存在しないため)。
 *
 * このテストは、そのフォールバックが実際に選ぶ値 — task token のみを Bearer
 * に渡すリクエスト（UI token は一切登場しない）— を、実スキルの curl と
 * 同じ形（GET /api/phase-prompts/:phase?render=skill&task_id=<self>）で
 * 実際の phasePromptsRoutes プラグイン + buildServer.ts と同じ認可フックに
 * 通し、200 で取得できることを確認する。加えて、同じ task token が
 * operator 専用ルートには 403 で弾かれることも確認し、「task token は
 * task 自身のフェーズプロンプトだけを読める」という設計の境界を守る。
 */

const UI_TOKEN = 'a'.repeat(64);
const TASK_ID = 7;
const TASK_SECRET = 'b'.repeat(64);
const TASK_TOKEN = formatTaskToken(TASK_ID, TASK_SECRET);

function buildApp(opts: { scopedAuthEnabled: boolean }): {
  app: FastifyInstance;
  renderSkillPromptUseCase: { render: ReturnType<typeof vi.fn> };
} {
  const verifyUiToken = createTokenVerifier(UI_TOKEN);
  const taskTokenRepo = { verify: vi.fn((taskId: number, secret: string) => taskId === TASK_ID && secret === TASK_SECRET) };

  const app = Fastify();

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api')) return;

    const principal = resolvePrincipal(request.headers.authorization, { verifyUiToken, taskTokenRepo });
    if (!principal) return reply.status(401).send({ error: 'Unauthorized' });
    request.principal = principal;

    const { allowed, operation } = evaluateRouteAuth(principal, request);
    if (!allowed) {
      if (opts.scopedAuthEnabled) {
        return reply.status(403).send({ error: 'operator_required', operation });
      }
    }
  });

  // Real UnitTypeLoader reading harness/unit-types/ — same source phasePromptSelfAuth's
  // condition and the route handler both resolve 'devops'/'planning' against in production.
  const unitTypeLoader = new UnitTypeLoader();
  const sidekickLoader = {} as SidekickPackageLoader; // unused on the render=skill path
  const renderSkillPromptUseCase = { render: vi.fn(async () => 'rendered planning prompt') };

  app.register(phasePromptsRoutes, {
    sidekickLoader,
    renderSkillPromptUseCase: renderSkillPromptUseCase as unknown as RenderSkillPromptUseCase,
    unitTypeLoader,
  });

  // Stand-in for an operator-only route (e.g. GET /api/units) — no `auth` config, default-deny.
  app.get('/api/operator-only', async () => ({ ok: true }));

  return { app, renderSkillPromptUseCase };
}

describe('task pane env with AZITO_TASK_TOKEN only (Issue #28 fix 1: harness skill fallback)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /api/phase-prompts/planning?render=skill&task_id=self succeeds with only the task token (AZITO_SCOPED_AUTH=1, no AZITO_UI_TOKEN in the pane)', async () => {
    const { app, renderSkillPromptUseCase } = buildApp({ scopedAuthEnabled: true });

    const res = await app.inject({
      method: 'GET',
      // Same request shape as harness/skills/azt-plan/SKILL.md's curl.
      url: `/api/phase-prompts/planning?render=skill&task_id=${TASK_ID}`,
      headers: { authorization: `Bearer ${TASK_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(renderSkillPromptUseCase.render).toHaveBeenCalledWith('planning', TASK_ID);

    await app.close();
  });

  it('the same task token is rejected with 403 against an operator-only route (scoped auth on)', async () => {
    const { app } = buildApp({ scopedAuthEnabled: true });

    const res = await app.inject({
      method: 'GET',
      url: '/api/operator-only',
      headers: { authorization: `Bearer ${TASK_TOKEN}` },
    });

    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('a task token for a different task id is rejected (task_id must equal the token owner)', async () => {
    const { app } = buildApp({ scopedAuthEnabled: true });

    const res = await app.inject({
      method: 'GET',
      url: `/api/phase-prompts/planning?render=skill&task_id=${TASK_ID + 1}`,
      headers: { authorization: `Bearer ${TASK_TOKEN}` },
    });

    expect(res.statusCode).toBe(403);

    await app.close();
  });
});
