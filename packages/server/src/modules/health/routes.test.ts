import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import healthRoutes from './routes';
import { DeployModeDetector } from '../system/DeployModeDetector';

describe('GET /api/health', () => {
  it('returns 200 with status ok and expected shape', async () => {
    const app = Fastify();
    await app.register(healthRoutes, { deployModeDetector: new DeployModeDetector(), scopedAuthEnabled: false });

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

  // Issue #28 third-party review Important finding: the frontend's
  // TaskOwnedPaneBadge must be able to tell compat mode (scoped
  // authorization not enforced — a UI token is deliberately injected into
  // every task pane) apart from actual enforcement, or it shows a
  // "restricted privileges" badge that isn't true.
  it('reflects scopedAuthEnabled=true when the hub was wired with it on', async () => {
    const app = Fastify();
    await app.register(healthRoutes, { deployModeDetector: new DeployModeDetector(), scopedAuthEnabled: true });

    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.json().scopedAuthEnabled).toBe(true);

    await app.close();
  });

  it('reflects scopedAuthEnabled=false when the hub is still in compat mode', async () => {
    const app = Fastify();
    await app.register(healthRoutes, { deployModeDetector: new DeployModeDetector(), scopedAuthEnabled: false });

    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.json().scopedAuthEnabled).toBe(false);

    await app.close();
  });
});
