import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import healthRoutes from './routes';
import { DeployModeDetector } from '../system/DeployModeDetector';

describe('GET /api/health', () => {
  it('returns 200 with status ok and expected shape', async () => {
    const app = Fastify();
    await app.register(healthRoutes, { deployModeDetector: new DeployModeDetector() });

    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.timestamp).toBe('string');
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
    expect(['systemd', 'launchd', 'source']).toContain(body.deployMode);

    await app.close();
  });
});
