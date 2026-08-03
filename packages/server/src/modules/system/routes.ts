import type { FastifyPluginCallback } from 'fastify';
import type { SystemUpdateService } from './SystemUpdateService';
import type { UpdateChannelResolver } from './UpdateChannelResolver';

interface SystemRouteOptions {
  systemUpdateService: SystemUpdateService;
  channelResolver: UpdateChannelResolver;
}

const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

const systemRoutes: FastifyPluginCallback<SystemRouteOptions> = (fastify, opts, done) => {
  const { systemUpdateService, channelResolver } = opts;

  fastify.get('/api/system/update/status', async () => {
    return systemUpdateService.getStatus();
  });

  fastify.post<{ Body: { version?: string } }>('/api/system/update', async (request, reply) => {
    const { version } = (request.body ?? {}) as { version?: string };
    if (version !== undefined) {
      if (typeof version !== 'string' || !VERSION_RE.test(version)) {
        return reply.status(400).send({ error: '無効なバージョン形式です' });
      }
    }
    const result = await systemUpdateService.startUpdate(version);
    if (!result.started) {
      return reply.status(409).send({ error: result.error });
    }
    return reply.status(202).send({ started: true });
  });

  fastify.get('/api/system/update/progress', async () => {
    return systemUpdateService.getProgress();
  });

  fastify.get('/api/system/update/channel', async () => {
    return { channel: channelResolver.resolveChannel() };
  });

  fastify.put<{ Body: { channel: string } }>('/api/system/update/channel', async (request, reply) => {
    const { channel } = (request.body ?? {}) as { channel?: string };
    if (channel !== 'stable' && channel !== 'rc') {
      return reply.status(400).send({ error: "channel must be 'stable' or 'rc'" });
    }
    channelResolver.updateChannelKind(channel);
    systemUpdateService.clearCache();
    return { channel };
  });

  fastify.get('/api/system/update/versions', async () => {
    return { versions: await systemUpdateService.fetchAvailableVersions() };
  });

  done();
};

export default systemRoutes;
