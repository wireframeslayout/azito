import type { FastifyPluginCallback } from 'fastify';
import type { IServerRepository } from '../Server';
import type { ResourceGuard } from './ResourceGuard';
import type { IResourceGuardSettingsRepository } from './SqliteResourceGuardSettingsRepository';
import type { TransportFactory } from '../transport/TransportFactory';
import type { IMuxClient } from '../../tmux/IMuxClient';
import { measureWindowResources } from './windowResources';

export interface ResourceGuardRouteOptions {
  settingsRepo: IResourceGuardSettingsRepository;
  resourceGuard: ResourceGuard;
  serverRepo: IServerRepository;
  transportFactory: TransportFactory;
  tmuxClient: IMuxClient;
}

const resourceGuardRoutes: FastifyPluginCallback<ResourceGuardRouteOptions> = (fastify, opts, done) => {
  const { settingsRepo, resourceGuard, serverRepo, transportFactory, tmuxClient } = opts;

  // ── GET /api/settings/resource-guard ──
  fastify.get('/api/settings/resource-guard', async () => {
    return settingsRepo.get();
  });

  // ── GET /api/servers/resources ──
  // 全サーバーの現在実測値を並列取得する
  fastify.get('/api/servers/resources', async () => {
    const servers = serverRepo.findAll();
    const measurements = await Promise.all(servers.map((s) => resourceGuard.measure(s)));
    const settings = settingsRepo.get();
    return {
      enabled: settings.enabled,
      memAvailablePercentMin: settings.memAvailablePercentMin,
      loadPerCoreMax: settings.loadPerCoreMax,
      servers: servers.map((s, i) => ({
        serverName: s.name,
        type: s.type,
        measurement: measurements[i],
      })),
    };
  });

  // ── GET /api/servers/:name/resources ──
  fastify.get<{ Params: { name: string }; Querystring: { detail?: string } }>('/api/servers/:name/resources', async (request, reply) => {
    const server = serverRepo.findByName(request.params.name);
    if (!server) return reply.status(404).send({ error: 'Server not found' });

    const measurement = await resourceGuard.measure(server);
    const settings = settingsRepo.get();

    let windows: { target: string; rssBytes: number }[] | undefined;
    if (request.query.detail === '1') {
      try {
        const transport = transportFactory.getTransport(server);
        windows = await measureWindowResources(transport, tmuxClient, server);
      } catch {
        windows = [];
      }
    }

    return {
      enabled: settings.enabled,
      memAvailablePercentMin: settings.memAvailablePercentMin,
      loadPerCoreMax: settings.loadPerCoreMax,
      serverName: server.name,
      type: server.type,
      measurement,
      ...(windows !== undefined ? { windows } : {}),
    };
  });

  // ── PUT /api/settings/resource-guard ──
  fastify.put('/api/settings/resource-guard', async (request, reply) => {
    // request.body は Content-Type 未指定などで undefined になり得るため正規化する
    const body = (request.body ?? {}) as {
      enabled?: unknown;
      memAvailablePercentMin?: unknown;
      loadPerCoreMax?: unknown;
    };

    const update: { enabled?: boolean; memAvailablePercentMin?: number; loadPerCoreMax?: number } = {};

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean')
        return reply.status(400).send({ error: 'enabled must be a boolean' });
      update.enabled = body.enabled;
    }
    if (body.memAvailablePercentMin !== undefined) {
      const v = body.memAvailablePercentMin;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)
        return reply.status(400).send({ error: 'memAvailablePercentMin must be a number between 0 and 100' });
      update.memAvailablePercentMin = v;
    }
    if (body.loadPerCoreMax !== undefined) {
      const v = body.loadPerCoreMax;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)
        return reply.status(400).send({ error: 'loadPerCoreMax must be a positive number' });
      update.loadPerCoreMax = v;
    }

    settingsRepo.update(update);
    return { ok: true, ...settingsRepo.get() };
  });

  done();
};

export default resourceGuardRoutes;
