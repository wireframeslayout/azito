import fs from 'fs';
import os from 'os';
import path from 'path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileBrowseRoutes } from './routes';
import { FileSearchService } from './FileSearchService';
import { LocalFileOps, localFileOpsHost } from '../../shared/fs/LocalFileOps';
import { RemoteFileOps, executeFileOp, fileOpRequestSchema } from '../../shared/fs/fileOpsWire';
import type { IFileOps } from '../../shared/fs/fileOps';
import { CommandSpawnError } from '../../shared/exec/commandSpec';
import { mapAppError } from '../../app/mapAppError';
import type { IServerRepository } from '../servers/Server';
import type { IProjectServerRepository } from '../projects/ProjectServer';

/**
 * `GET /files/search` end to end on this host's own paths (a Windows host in the Windows CI job): the real route, the real
 * FileSearchService and the real file operations. No rg / grep is installed for the test (every spawn is ENOENT), which is
 * what a Windows host without ripgrep is, so the built-in search answers.
 */
describe('GET /api/servers/:name/files/search — built-in content search through the route', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'azito-search-route-')));
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'deep', 'a.txt'), 'first\nneedle here\n');
    fs.writeFileSync(path.join(root, 'top.txt'), 'a needle at the top\n');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'skipped.txt'), 'needle\n');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const platform = process.platform === 'win32' ? 'win32' : 'linux';

  async function appWith(files: IFileOps) {
    const transport = {
      files: () => files,
      run: async () => {
        throw new CommandSpawnError('ENOENT', 'spawn ENOENT');
      },
    };
    const transportFactory = {
      hostProfileFor: () => ({ platform }),
      getFileOps: () => files,
      getTransport: () => transport,
    } as any;
    const app = Fastify();
    app.setErrorHandler((err, _request, reply) => {
      const mapped = mapAppError(err);
      if (!mapped) return reply.status(500).send({ error: (err as Error).message });
      return reply.status(mapped.status).send(mapped.body);
    });
    app.register(fileBrowseRoutes, {
      serverRepo: { findByName: () => ({ name: 'srv', type: 'agent' }) } as unknown as IServerRepository,
      projectServerRepo: { find: () => ({ workingDirectory: root }) } as unknown as IProjectServerRepository,
      transportFactory,
      searchService: new FileSearchService(transportFactory),
    } as any);
    await app.ready();
    return app;
  }

  const hostOps = (): LocalFileOps => new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: root }));
  /** An agent in one process: the request and the response both go through JSON, as they do over `POST /api/fileops`. */
  const agentOps = (): RemoteFileOps => {
    const local = hostOps();
    return new RemoteFileOps(local.platform, async (request) => {
      const body = await executeFileOp(local, fileOpRequestSchema.parse(JSON.parse(JSON.stringify(request))));
      return JSON.parse(JSON.stringify(body));
    });
  };

  for (const [label, makeOps] of [['the hub\'s own host (LocalFileOps)', hostOps], ['an agent (RemoteFileOps -> /api/fileops)', agentOps]] as const) {
    it(`answers with the built-in engine and root-relative "/" paths on ${label}`, async () => {
      const app = await appWith(makeOps());
      const res = await app.inject({ method: 'GET', url: '/api/servers/srv/files/search?q=needle&project_id=1' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { engine: string; contentHits: { path: string; line: number; text: string }[] };
      expect(body.engine).toBe('builtin');
      const hits = body.contentHits.map((hit) => `${hit.path}:${hit.line}`).sort();
      expect(hits).toEqual(['src/deep/a.txt:2', 'top.txt:1']);
      await app.close();
    });
  }
});
