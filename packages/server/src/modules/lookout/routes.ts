import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { requireOperator } from '../../shared/auth/requireOperator';
import { probeLookoutLlm } from './LlmClientFactory';
import type { LookoutSummaryService } from './LookoutSummaryService';
import type { SqliteLookoutSettingsRepository } from './SqliteLookoutSettingsRepository';

const settingsSchema = z.object({ enabled: z.boolean(), provider: z.enum(['claude', 'codex']), model: z.string().min(1).max(200).refine((s) => s.trim() === s && !s.startsWith('-') && !/[\x00-\x1f\x7f-\x9f]/.test(s)) }).strict();
const requestsSchema = z.array(z.object({ windowId: z.number().int().positive(), state: z.enum(['blocked', 'working', 'finished']) }).strict()).max(50).refine((items) => new Set(items.map((item) => item.windowId)).size === items.length);

export const lookoutRoutes: FastifyPluginCallback<{ settings: SqliteLookoutSettingsRepository; service: LookoutSummaryService }> = (app, { settings, service }, done) => {
  app.addHook('preHandler', requireOperator('settings.lookout'));
  app.get('/api/settings/lookout', async () => settings.get());
  app.put('/api/settings/lookout', async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid Lookout settings' });
    const result = settings.update(parsed.data);
    service.invalidate();
    return result;
  });
  app.post('/api/settings/lookout/probe', async () => probeLookoutLlm(settings.get()));
  app.get<{ Querystring: { windowIds?: string; states?: string } }>('/api/lookout/summaries', async (request, reply) => {
    const ids = request.query.windowIds;
    if (typeof ids !== 'string' || !/^(?:[1-9]\d*)(?:,[1-9]\d*)*$/.test(ids)) return reply.status(400).send({ error: 'Invalid windowIds' });
    const windowIds = ids.split(',').map(Number);
    if (windowIds.length > 50 || windowIds.some((id) => !Number.isSafeInteger(id)) || new Set(windowIds).size !== windowIds.length) return reply.status(400).send({ error: 'Invalid windowIds' });
    let raw: unknown;
    try { raw = JSON.parse(request.query.states ?? ''); } catch { return reply.status(400).send({ error: 'Invalid states' }); }
    const parsed = requestsSchema.safeParse(raw);
    if (!parsed.success || parsed.data.length !== windowIds.length || parsed.data.some((item) => !windowIds.includes(item.windowId))) return reply.status(400).send({ error: 'Invalid states' });
    const byId = new Map(parsed.data.map((item) => [item.windowId, item]));
    return { summaries: await service.getSummaries(windowIds.map((id) => byId.get(id)!)) };
  });
  done();
};
