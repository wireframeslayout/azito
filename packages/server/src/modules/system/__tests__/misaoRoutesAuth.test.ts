import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenVerifier } from '../../servers/auth/tokenAuth';
import { resolvePrincipal } from '../../../shared/auth/resolvePrincipal';
import { formatTaskToken } from '../../../shared/auth/taskTokenFormat';
import systemRoutes from '../routes';
import type { MisaoServiceService } from '../misao/MisaoServiceService';

const UI_TOKEN = 'a'.repeat(64);
const TASK_TOKEN = formatTaskToken(7, 'b'.repeat(64));

/**
 * The hub's onRequest hook resolves the principal and rejects routes not open to it only with AZITO_SCOPED_AUTH on. This
 * models the compat-mode (flag off) worst case: the hook resolves the principal (same resolvePrincipal) and lets every
 * principal through. With the flag on the hook is stricter, never looser, so the route-level guard is what is under test.
 */
async function buildApp(): Promise<{ app: FastifyInstance; misao: Record<'status' | 'install' | 'start' | 'update', ReturnType<typeof vi.fn>> }> {
  const misao = { status: vi.fn(), install: vi.fn(), start: vi.fn(), update: vi.fn() };
  for (const fn of Object.values(misao)) fn.mockResolvedValue({ managed: true });
  const verifyUiToken = createTokenVerifier(UI_TOKEN);
  const taskTokenRepo = { verify: (taskId: number, secret: string) => taskId === 7 && secret === 'b'.repeat(64) };
  const app = Fastify();
  app.addHook('onRequest', async (request, reply) => {
    const principal = resolvePrincipal(request.headers.authorization, { verifyUiToken, taskTokenRepo });
    if (!principal) return reply.status(401).send({ error: 'Unauthorized' });
    request.principal = principal;
  });
  await app.register(systemRoutes, { systemUpdateService: {} as never, channelResolver: {} as never, misaoService: misao as unknown as MisaoServiceService });
  return { app, misao };
}

describe('misao service mutations stay operator-only even when the global hook lets a task principal through', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it.each([
    ['install', {}],
    ['start', undefined],
    ['update', { closeAllPanes: true }],
  ])('rejects a task token on %s with 403 and does nothing', async (action, payload) => {
    const built = await buildApp();
    app = built.app;
    const res = await app.inject({ method: 'POST', url: `/api/system/misao/${action}`, headers: { authorization: `Bearer ${TASK_TOKEN}` }, ...(payload ? { payload } : {}) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('operator_required');
    expect(built.misao[action as 'install' | 'start' | 'update']).not.toHaveBeenCalled();
  });

  it('lets the operator update, and lets a task token read the status', async () => {
    const built = await buildApp();
    app = built.app;
    const ok = await app.inject({ method: 'POST', url: '/api/system/misao/update', headers: { authorization: `Bearer ${UI_TOKEN}` }, payload: { closeAllPanes: true } });
    expect(ok.statusCode).toBe(200);
    const read = await app.inject({ method: 'GET', url: '/api/system/misao', headers: { authorization: `Bearer ${TASK_TOKEN}` } });
    expect(read.statusCode).toBe(200);
  });
});
