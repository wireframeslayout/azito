import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { IServerRepository } from '../servers/Server';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { SqliteMuxSwitchSettingsRepository } from './SqliteMuxSwitchSettingsRepository';

const schema = z.object({ mode: z.enum(['ask', 'misao', 'tmux']) }).strict();

export const muxSwitchSettingsRoutes: FastifyPluginCallback<{ settingsRepo: SqliteMuxSwitchSettingsRepository; serverRepo: IServerRepository; muxDriverRegistry: MuxDriverRegistry }> = (fastify, { settingsRepo, serverRepo, muxDriverRegistry }, done) => {
  fastify.get('/api/settings/mux-switch', async () => ({ mode: settingsRepo.get() }));
  fastify.get('/api/settings/mux-switch/servers', async () => serverRepo.findAll().filter((server) => muxDriverRegistry.supportedKinds(server).includes('misao')).map((server) => ({ name: server.name, defaultMux: server.defaultMux })));
  fastify.put('/api/settings/mux-switch', async (request, reply) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid mux switch settings' });
    settingsRepo.set(parsed.data.mode);
    return { mode: parsed.data.mode };
  });
  done();
};
