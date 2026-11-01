import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { up } from '../../shared/db/migrations/084_mux_switch_settings';
import { SqliteMuxSwitchSettingsRepository } from './SqliteMuxSwitchSettingsRepository';
import { muxSwitchSettingsRoutes } from './muxSwitchSettingsRoutes';

describe('mux switch settings API', () => {
  it('persists valid settings and rejects invalid and extra fields', async () => {
    const db = new Database(':memory:');
    up(db);
    const app = Fastify();
    await app.register(muxSwitchSettingsRoutes, { settingsRepo: new SqliteMuxSwitchSettingsRepository(db), serverRepo: { findAll: () => [] } as never, muxDriverRegistry: {} as never });
    expect((await app.inject({ method: 'GET', url: '/api/settings/mux-switch' })).json()).toMatchObject({ mode: 'ask' });
    expect((await app.inject({ method: 'PUT', url: '/api/settings/mux-switch', payload: { mode: 'misao' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/settings/mux-switch' })).json()).toMatchObject({ mode: 'misao' });
    expect((await app.inject({ method: 'PUT', url: '/api/settings/mux-switch', payload: { mode: 'tmux', extra: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/mux-switch', payload: { mode: 'invalid' } })).statusCode).toBe(400);
    await app.close(); db.close();
  });
});
