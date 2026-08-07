import type { FastifyPluginCallback } from 'fastify';
import type { IProjectRepository } from '../projects/Project';
import type { IStorageSettingsRepository } from './SqliteStorageSettingsRepository';
import type { MinioStorageClient } from './storage/MinioStorageClient';
import type { IServerRepository } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import { FileBrowseService, FileBrowseError } from './FileBrowseService';

export function sanitizeFileName(raw: string): string {
  const nfc = raw.normalize('NFC');
  return nfc
    .replace(/[/\\]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '')
    .trim() || 'file';
}

export interface StorageRouteOptions {
  projectRepo: IProjectRepository;
  storageSettingsRepo: IStorageSettingsRepository;
  storageClient: MinioStorageClient;
}

const storageRoutes: FastifyPluginCallback<StorageRouteOptions> = (fastify, opts, done) => {
  const { projectRepo, storageSettingsRepo, storageClient } = opts;

  // ── GET /api/projects/:id/storage ──
  fastify.get<{ Params: { id: string } }>(
    '/api/projects/:id/storage',
    async (request, reply) => {
      const projectId = parseInt(request.params.id, 10);
      if (!projectRepo.findById(projectId))
        return reply.status(404).send({ error: 'Project not found' });
      const settings = storageSettingsRepo.get();
      try {
        const files = await storageClient.list(settings, projectId);
        return { files };
      } catch (err: unknown) {
        return reply.status(502).send({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/projects/:id/storage/upload ──
  fastify.post<{ Params: { id: string } }>(
    '/api/projects/:id/storage/upload',
    async (request, reply) => {
      const projectId = parseInt(request.params.id, 10);
      if (!projectRepo.findById(projectId))
        return reply.status(404).send({ error: 'Project not found' });

      const settings = storageSettingsRepo.get();

      const data = await request.file();
      if (!data) return reply.status(400).send({ error: 'No file uploaded' });

      const buffer = await data.toBuffer();
      if (buffer.length > settings.maxFileSize) {
        return reply.status(413).send({
          error: `File too large. Max ${Math.round(settings.maxFileSize / 1024 / 1024)}MB`,
        });
      }

      const timestamp = Date.now();
      const safeName = sanitizeFileName(data.filename);
      const storedName = `${timestamp}_${safeName}`;

      try {
        await storageClient.ensureBucket(settings);
        const file = await storageClient.upload(
          settings, projectId, storedName, buffer, data.mimetype,
        );
        return { ok: true, file };
      } catch (err: unknown) {
        return reply.status(502).send({ error: (err as Error).message });
      }
    },
  );

  // ── DELETE /api/projects/:id/storage/:filename ──
  fastify.delete<{ Params: { id: string; filename: string } }>(
    '/api/projects/:id/storage/:filename',
    async (request, reply) => {
      const projectId = parseInt(request.params.id, 10);
      if (!projectRepo.findById(projectId))
        return reply.status(404).send({ error: 'Project not found' });

      const settings = storageSettingsRepo.get();
      try {
        await storageClient.delete(settings, projectId, decodeURIComponent(request.params.filename));
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(502).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/projects/:id/storage/:filename/url ──
  fastify.get<{ Params: { id: string; filename: string } }>(
    '/api/projects/:id/storage/:filename/url',
    async (request, reply) => {
      const projectId = parseInt(request.params.id, 10);
      if (!projectRepo.findById(projectId))
        return reply.status(404).send({ error: 'Project not found' });

      const settings = storageSettingsRepo.get();
      const filename = decodeURIComponent(request.params.filename);
      const url = storageClient.getDirectUrl(settings, projectId, filename);
      return { url };
    },
  );

  // ── GET /api/projects/:id/storage/:filename/raw ──
  fastify.get<{ Params: { id: string; filename: string }; Querystring: { download?: string } }>(
    '/api/projects/:id/storage/:filename/raw',
    async (request, reply) => {
      const projectId = parseInt(request.params.id, 10);
      if (!projectRepo.findById(projectId))
        return reply.status(404).send({ error: 'Project not found' });

      const settings = storageSettingsRepo.get();
      const filename = decodeURIComponent(request.params.filename);
      const url = storageClient.getDirectUrl(settings, projectId, filename);
      try {
        const res = await fetch(url);
        if (!res.ok) return reply.status(res.status).send({ error: 'File not found' });
        const contentType = res.headers.get('content-type') || 'application/octet-stream';
        reply.header('Content-Type', contentType);
        reply.header('Cache-Control', 'public, max-age=3600');
        if (request.query.download === 'true') {
          // Extract original name: strip timestamp prefix (e.g. "1234567890_filename.txt" -> "filename.txt")
          const originalName = filename.replace(/^\d+_/, '') || filename;
          const encoded = encodeURIComponent(originalName);
          reply.header('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        return reply.send(buffer);
      } catch (err: unknown) {
        return reply.status(502).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/storage/settings ──
  fastify.get('/api/storage/settings', async () => {
    const settings = storageSettingsRepo.get();
    return {
      endpoint: settings.endpoint,
      bucket: settings.bucket,
      region: settings.region,
      maxFileSize: settings.maxFileSize,
      useSsl: settings.useSsl,
    };
  });

  // ── PUT /api/storage/settings ──
  fastify.put('/api/storage/settings', async (request) => {
    const body = request.body as Record<string, unknown>;
    storageSettingsRepo.update({
      endpoint: body.endpoint as string | undefined,
      accessKey: body.access_key as string | undefined,
      secretKey: body.secret_key as string | undefined,
      bucket: body.bucket as string | undefined,
      region: body.region as string | undefined,
      maxFileSize: body.max_file_size as number | undefined,
      useSsl: body.use_ssl as boolean | undefined,
    });
    return { ok: true };
  });

  done();
};

// ─── File browse routes (servers/:name/files, /directories) ───

export interface FileBrowseRouteOptions {
  serverRepo: IServerRepository;
  tmux: TmuxClient;
}

export const fileBrowseRoutes: FastifyPluginCallback<FileBrowseRouteOptions> = (fastify, opts, done) => {
  const { serverRepo, tmux } = opts;
  const fileBrowseService = new FileBrowseService(tmux);

  // ── GET /api/servers/:name/directories ──
  fastify.get<{ Params: { name: string }; Querystring: { path?: string } }>(
    '/api/servers/:name/directories',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const inputPath = (request.query.path || '').trim();
      if (/[\x00-\x1f]/.test(inputPath)) return reply.status(400).send({ error: 'Invalid path' });
      return fileBrowseService.listDirectories(srv, inputPath);
    },
  );

  // ── GET /api/servers/:name/files ──
  fastify.get<{ Params: { name: string }; Querystring: { path?: string; showHidden?: string } }>(
    '/api/servers/:name/files',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const dirPath = (request.query.path || '').trim();
      if (!dirPath) return reply.status(400).send({ error: 'path query parameter required' });
      if (/[\x00-\x1f]/.test(dirPath)) return reply.status(400).send({ error: 'Invalid path' });
      const showHidden = request.query.showHidden === 'true';

      try {
        return await fileBrowseService.listFiles(srv, dirPath, showHidden);
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/servers/:name/files/content ──
  fastify.get<{ Params: { name: string }; Querystring: { path?: string } }>(
    '/api/servers/:name/files/content',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const filePath = (request.query.path || '').trim();
      if (/[\x00-\x1f]/.test(filePath)) return reply.status(400).send({ error: 'Invalid path' });
      if (!filePath) return reply.status(400).send({ error: 'path query parameter required' });

      try {
        return await fileBrowseService.getFileContent(srv, filePath);
      } catch (err: unknown) {
        if (err instanceof FileBrowseError) return reply.status(err.status).send({ error: err.message });
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/servers/:name/files/download ──
  fastify.get<{ Params: { name: string }; Querystring: { path?: string } }>(
    '/api/servers/:name/files/download',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const filePath = (request.query.path || '').trim();
      if (/[\x00-\x1f]/.test(filePath)) return reply.status(400).send({ error: 'Invalid path' });
      if (!filePath) return reply.status(400).send({ error: 'path query parameter required' });

      try {
        const { buffer, contentType, basename } = await fileBrowseService.downloadFile(srv, filePath);
        reply.header('Content-Type', contentType);
        reply.header('Content-Disposition', `attachment; filename="${basename}"`);
        reply.header('Content-Length', buffer.length);
        return reply.send(buffer);
      } catch (err: unknown) {
        if (err instanceof FileBrowseError) return reply.status(err.status).send({ error: err.message });
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── PUT /api/servers/:name/files/content ──
  fastify.put<{ Params: { name: string } }>(
    '/api/servers/:name/files/content',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const body = request.body as Record<string, unknown>;
      const filePath = typeof body.path === 'string' ? body.path.trim() : '';
      if (!filePath) return reply.status(400).send({ error: 'path is required' });
      if (typeof body.content !== 'string') return reply.status(400).send({ error: 'content is required' });
      const content = body.content;
      const baseMtime = typeof body.baseMtime === 'number' ? body.baseMtime : undefined;
      const force = body.force === true;

      try {
        const result = await fileBrowseService.writeFileContent(
          srv,
          filePath,
          content,
          force ? undefined : baseMtime,
        );
        return { ok: true, mtime: result.mtime };
      } catch (err: unknown) {
        if (err instanceof FileBrowseError) {
          if (err.status === 409) {
            try {
              const parsed = JSON.parse(err.message);
              return reply.status(409).send({ error: 'conflict', currentMtime: parsed.currentMtime });
            } catch {
              return reply.status(409).send({ error: 'conflict' });
            }
          }
          return reply.status(err.status).send({ error: err.message });
        }
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  done();
};

export default storageRoutes;
