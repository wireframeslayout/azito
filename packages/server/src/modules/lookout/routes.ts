import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { probeLookoutLlm } from './LlmClientFactory';
import type { LookoutSummaryService } from './LookoutSummaryService';
import type { SqliteLookoutSettingsRepository } from './SqliteLookoutSettingsRepository';

const settingsSchema = z.object({ enabled: z.boolean(), provider: z.enum(['claude', 'codex']), model: z.string().min(1).max(200).refine((s) => s.trim() === s && !s.startsWith('-') && !/[\x00-\x1f\x7f-\x9f]/.test(s)) }).strict();
const requestsSchema = z.array(z.object({ windowId: z.number().int().positive(), state: z.enum(['blocked', 'working', 'completed']) }).strict()).max(50).refine((items) => new Set(items.map((item) => item.windowId)).size === items.length);

export const lookoutRoutes: FastifyPluginCallback<{ settings: SqliteLookoutSettingsRepository; service: LookoutSummaryService }> = (app, { settings, service }, done) => {
  app.addHook('preHandler', async (request, reply) => {
    if (request.principal?.class !== 'operator') return reply.status(403).send({ error: 'operator_required' });
  });
  app.get('/api/settings/lookout', async () => settings.get());
  app.put('/api/settings/lookout', async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid Lookout settings' });
    const result = settings.update(parsed.data);
    service.invalidate();
    return result;
  });
  app.post('/api/settings/lookout/probe', async () => probeLookoutLlm(settings.get()));
  app.get<{ Querystring: { windows?: string } }>('/api/lookout/summaries', async (request, reply) => {
    let raw: unknown;
    try { raw = JSON.parse(request.query.windows ?? ''); } catch { return reply.status(400).send({ error: 'Invalid windows' }); }
    const parsed = requestsSchema.safeParse(raw);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid windows' });
    return { summaries: await service.getSummaries(parsed.data) };
  });
  done();
};
