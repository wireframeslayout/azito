import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import type { SystemUpdateService } from './SystemUpdateService';
import type { UpdateChannelResolver } from './UpdateChannelResolver';
import type { MisaoServiceService } from './misao/MisaoServiceService';
import { requireOperator, runMisaoOperation } from './misao/misaoRouteSupport';

interface SystemRouteOptions {
  systemUpdateService: SystemUpdateService;
  channelResolver: UpdateChannelResolver;
  misaoService: MisaoServiceService;
}

const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

const systemRoutes: FastifyPluginCallback<SystemRouteOptions> = (fastify, opts, done) => {
  const { systemUpdateService, channelResolver, misaoService } = opts;

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

  // ── misao service ──
  // The daemon is its own service next to the hub; its panes die when it stops. Nothing here runs on a schedule or as
  // part of a hub update: install / start / update are explicit user actions, and update must say so in the body.

  fastify.get('/api/system/misao', async () => misaoService.status());

  // These three can end every pane, so they require the operator principal themselves, in both auth modes.
  const operatorOnly = requireOperator('system.misao');

  fastify.post<{ Body: { replaceSocketSetting?: boolean } }>('/api/system/misao/install', { preHandler: operatorOnly }, async (request, reply) => {
    const replaceSocketSetting = request.body?.replaceSocketSetting === true;
    return runMisaoOperation(reply, () => misaoService.install({ replaceSocketSetting }));
  });

  fastify.post('/api/system/misao/start', { preHandler: operatorOnly }, async (_request, reply) => runMisaoOperation(reply, () => misaoService.start()));

  fastify.post<{ Body: { closeAllPanes?: boolean } }>('/api/system/misao/update', { preHandler: operatorOnly }, async (request, reply) => {
    if (request.body?.closeAllPanes !== true) {
      return reply.status(400).send({ error: 'Updating misao stops the daemon and closes every pane; send { "closeAllPanes": true } to confirm.', code: 'usage' });
    }
    return runMisaoOperation(reply, () => misaoService.update());
  });

  done();
};

export default systemRoutes;
