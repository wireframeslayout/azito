import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import systemRoutes from '../routes';
import { OPERATOR_PRINCIPAL } from '../../../shared/auth/Principal';
import { MisaoServiceError, type MisaoServiceService } from '../misao/MisaoServiceService';

const STATUS = { managed: true, serviceInstalled: true, daemon: { reachable: true }, socketSetting: 'managed', needsHubRestart: false, updateAvailable: false };

describe('misao service routes', () => {
  let app: FastifyInstance;
  const misaoService = {
    status: vi.fn(),
    install: vi.fn(),
    start: vi.fn(),
    update: vi.fn(),
  };

  beforeEach(async () => {
    for (const fn of Object.values(misaoService)) fn.mockReset().mockResolvedValue(STATUS);
    app = Fastify();
    app.addHook('onRequest', async (request) => { request.principal = OPERATOR_PRINCIPAL; });
    await app.register(systemRoutes, {
      systemUpdateService: {} as never,
      channelResolver: {} as never,
      misaoService: misaoService as unknown as MisaoServiceService,
    });
  });
  afterEach(async () => { await app.close(); });

  it('GET reports the service status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/misao' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(STATUS);
  });

  it('install passes replaceSocketSetting only when it is exactly true', async () => {
    await app.inject({ method: 'POST', url: '/api/system/misao/install', payload: { replaceSocketSetting: 'yes' } });
    expect(misaoService.install).toHaveBeenLastCalledWith({ replaceSocketSetting: false });
    await app.inject({ method: 'POST', url: '/api/system/misao/install', payload: { replaceSocketSetting: true } });
    expect(misaoService.install).toHaveBeenLastCalledWith({ replaceSocketSetting: true });
  });

  it('update refuses to stop the daemon unless the body confirms that every pane will close', async () => {
    const without = await app.inject({ method: 'POST', url: '/api/system/misao/update' });
    expect(without.statusCode).toBe(400);
    expect(without.json().code).toBe('usage');
    expect(misaoService.update).not.toHaveBeenCalled();

    const confirmed = await app.inject({ method: 'POST', url: '/api/system/misao/update', payload: { closeAllPanes: true } });
    expect(confirmed.statusCode).toBe(200);
    expect(misaoService.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not_installed', 409],
    ['custom_socket', 409],
    ['busy', 409],
    ['daemon_not_ready', 502],
  ] as const)('maps a %s refusal to HTTP %i with its message', async (code, status) => {
    misaoService.start.mockRejectedValue(new MisaoServiceError(code, 'because'));
    const res = await app.inject({ method: 'POST', url: '/api/system/misao/start' });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: 'because', code });
  });

  it('lets an unexpected failure surface as a 500 instead of describing it as a refusal', async () => {
    misaoService.start.mockRejectedValue(new Error('boom'));
    const res = await app.inject({ method: 'POST', url: '/api/system/misao/start' });
    expect(res.statusCode).toBe(500);
  });
});
