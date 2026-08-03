import type { FastifyPluginCallback } from 'fastify';
import type { IProviderRepository } from '../llm/Provider';
import {
  testProvider as testProviderFn,
  getAvailableModels,
  getWorkerTypes,
  getWorkerModels,
} from '../llm/LlmClient';
import { listAgentDefinitions, getAgentsForContext } from './registry';
import type { AgentContext } from './AgentProvider';
import { validateCustomBaseUrl } from '../../shared/validation/urlValidation';

// ─── Types ───

export interface ProvidersRouteOptions {
  providerRepo: IProviderRepository;
}

// ─── Helpers ───

function maskKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

const OFFICIAL_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

async function validateProviderBaseUrl(
  providerType: string,
  baseUrl: string | null | undefined,
): Promise<string | null> {
  if (!baseUrl) return null;
  if (providerType in OFFICIAL_BASE_URLS) {
    if (baseUrl !== OFFICIAL_BASE_URLS[providerType]) {
      return `base_url is fixed for provider type "${providerType}"`;
    }
    return null;
  }
  return validateCustomBaseUrl(baseUrl);
}

// ─── Plugin ───

const providersRoutes: FastifyPluginCallback<ProvidersRouteOptions> = (fastify, opts, done) => {
  const { providerRepo } = opts;

  // ── GET /api/providers ──
  fastify.get('/api/providers', async () => {
    return providerRepo.findAll().map((p) => ({
      ...p,
      apiKey: maskKey(p.apiKey),
    }));
  });

  // ── POST /api/providers ──
  fastify.post('/api/providers', async (request, reply) => {
    const { id, name, type, api_key, base_url } = request.body as Record<string, unknown>;
    if (!id || !name || !type)
      return reply.status(400).send({ error: 'id, name, type required' });
    if (providerRepo.findById(id as string))
      return reply.status(409).send({ error: 'Provider already exists' });

    const baseUrlErr = await validateProviderBaseUrl(type as string, base_url as string | undefined);
    if (baseUrlErr) return reply.status(400).send({ error: baseUrlErr });

    try {
      providerRepo.create({
        id: id as string,
        name: name as string,
        type: type as 'openai' | 'anthropic' | 'custom',
        apiKey: (api_key as string) ?? null,
        baseUrl: (base_url as string) ?? null,
      });
      return { ok: true };
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── PUT /api/providers/:id ──
  fastify.put<{ Params: { id: string } }>(
    '/api/providers/:id',
    async (request, reply) => {
      const existing = providerRepo.findById(request.params.id);
      if (!existing) return reply.status(404).send({ error: 'Provider not found' });
      const { name, type, api_key, base_url } = request.body as Record<string, unknown>;
      const nextType = ((type as string) || existing.type) as 'openai' | 'anthropic' | 'custom';
      const nextBaseUrl = base_url !== undefined ? (base_url as string) : existing.baseUrl;

      const baseUrlErr = await validateProviderBaseUrl(nextType, nextBaseUrl);
      if (baseUrlErr) return reply.status(400).send({ error: baseUrlErr });

      const endpointChanged = nextBaseUrl !== existing.baseUrl;
      if (endpointChanged && api_key === undefined) {
        return reply.status(400).send({ error: 'api_key must be re-entered when base_url changes' });
      }

      const finalKey = api_key === undefined ? existing.apiKey : (api_key as string);
      try {
        providerRepo.update(request.params.id, {
          name: (name as string) || existing.name,
          type: nextType,
          apiKey: finalKey,
          baseUrl: nextBaseUrl,
        });
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── DELETE /api/providers/:id ──
  fastify.delete<{ Params: { id: string } }>(
    '/api/providers/:id',
    async (request, reply) => {
      if (!providerRepo.findById(request.params.id))
        return reply.status(404).send({ error: 'Provider not found' });
      providerRepo.delete(request.params.id);
      return { ok: true };
    },
  );

  // ── POST /api/providers/:id/test ──
  fastify.post<{ Params: { id: string } }>(
    '/api/providers/:id/test',
    async (request, reply) => {
      const provider = providerRepo.findById(request.params.id);
      if (!provider) return reply.status(404).send({ error: 'Provider not found' });
      const result = await testProviderFn({
        type: provider.type,
        api_key: provider.apiKey!,
        base_url: provider.baseUrl,
      });
      return result;
    },
  );

  // ── GET /api/providers/models/:type ──
  fastify.get<{ Params: { type: string } }>(
    '/api/providers/models/:type',
    async (request) => {
      return getAvailableModels(request.params.type);
    },
  );

  // ── GET /api/agents ──
  fastify.get<{ Querystring: { context?: string } }>(
    '/api/agents',
    async (request) => {
      const { context } = request.query;
      if (context === 'worker' || context === 'subagent') {
        return getAgentsForContext(context as AgentContext);
      }
      return listAgentDefinitions();
    },
  );

  // ── GET /api/workers/types ──
  fastify.get('/api/workers/types', async () => {
    return getWorkerTypes();
  });

  // ── GET /api/workers/models/:type ──
  fastify.get<{ Params: { type: string } }>(
    '/api/workers/models/:type',
    async (request) => {
      return getWorkerModels(request.params.type);
    },
  );

  done();
};

export default providersRoutes;
