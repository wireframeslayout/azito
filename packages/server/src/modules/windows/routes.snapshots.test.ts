import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import windowsRoutes, { type WindowsRouteOptions } from './routes';

it('validates snapshots queries and passes normalized values to the service', async () => {
  const capture = vi.fn().mockResolvedValue([{ id: 2, status: 'error', code: 'window_not_found', message: 'Window not found' }]);
  const app = Fastify();
  await app.register(windowsRoutes, { windowSnapshotService: { capture } } as unknown as WindowsRouteOptions);
  const ok = await app.inject('/api/windows/snapshots?ids=2,1,2&since=1:0');
  expect(ok.statusCode).toBe(200);
  expect(ok.json().snapshots).toHaveLength(1);
  expect(capture).toHaveBeenCalledWith([2, 1], 12, new Map([[1, 0]]));
  for (const query of ['ids=0', 'ids=1&lines=61', 'ids=1&since=1:0,1:2']) {
    expect((await app.inject(`/api/windows/snapshots?${query}`)).statusCode).toBe(400);
  }
  await app.close();
});
