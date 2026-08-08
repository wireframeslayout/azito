import * as path from 'path';
import type { FastifyPluginCallback } from 'fastify';
import type { IProjectRepository } from '../projects/Project';
import type { IStorageSettingsRepository } from './SqliteStorageSettingsRepository';
import type { MinioStorageClient } from './storage/MinioStorageClient';
import type { IServerRepository } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { FileBrowseService, FileBrowseError } from './FileBrowseService';
import type { FileSearchService } from './FileSearchService';
import { assertDirectoryContained, isPathContained, PathResolverFactory } from '../git/PathContainment';

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
  projectServerRepo: IProjectServerRepository;
  transportFactory: TransportFactory;
  searchService: FileSearchService;
}

export const fileBrowseRoutes: FastifyPluginCallback<FileBrowseRouteOptions> = (fastify, opts, done) => {
  const { serverRepo, tmux, projectServerRepo, transportFactory, searchService } = opts;
  const fileBrowseService = new FileBrowseService(tmux);
  const resolverFactory = new PathResolverFactory();

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
      if (/[\x00-\x1f]/.test(filePath)) return reply.status(400).send({ error: 'Invalid path' });
      if (typeof body.content !== 'string') return reply.status(400).send({ error: 'content is required' });
      const content = body.content;
      const baseMtime = typeof body.baseMtime === 'number' ? body.baseMtime : undefined;
      const force = body.force === true;
      const projectId = typeof body.projectId === 'number' ? body.projectId : NaN;
      if (isNaN(projectId)) return reply.status(400).send({ error: 'projectId is required' });

      const ps = projectServerRepo.find(projectId, srv.name);
      if (!ps?.workingDirectory) return reply.status(400).send({ error: 'Project server has no working directory' });

      let writeTargetPath = filePath;
      try {
        const transport = srv.type !== 'local' ? transportFactory.getTransport(srv) : undefined;
        const parentDir = path.dirname(filePath);
        await assertDirectoryContained(resolverFactory, srv.type, transport, { target: parentDir, allowedRoot: ps.workingDirectory }, 'target path');

        // Parent-directory containment alone doesn't catch a save target
        // that is itself a symlink pointing outside workingDirectory — the
        // write would land at the symlink's target. When the target already
        // exists, resolve its real path and re-verify containment on that
        // (Issue #27 review Critical 2); a target that doesn't exist yet has
        // no symlink to escape through, so it's created directly under the
        // already-contained parent.
        const existingRealPath = await fileBrowseService.resolveExistingTargetRealPath(srv, filePath);
        if (existingRealPath != null) {
          const resolver = resolverFactory.create(srv.type, transport);
          const resolvedRoot = await resolver.resolveRealPath(ps.workingDirectory);
          if (!isPathContained({ target: existingRealPath, allowedRoot: resolvedRoot })) {
            return reply.status(400).send({ error: 'target path escapes the allowed directory' });
          }
          // Use the resolved real path — not the original request path — for
          // the actual write, so the verified path is what's acted on rather
          // than the pre-verification value (TOCTOU-adjacent discard).
          writeTargetPath = existingRealPath;
        }
      } catch (err: unknown) {
        const message = (err as Error).message;
        if (message.includes('escapes the allowed directory') || message.includes('Cannot verify')) {
          return reply.status(400).send({ error: message });
        }
        return reply.status(500).send({ error: message });
      }

      try {
        const result = await fileBrowseService.writeFileContent(
          srv,
          writeTargetPath,
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

  // ── POST /api/servers/:name/files (create file/directory) ──
  fastify.post<{ Params: { name: string }; Body: { projectId: number; path: string; type: 'file' | 'directory' } }>(
    '/api/servers/:name/files',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const { projectId, path: rawPath, type } = request.body as { projectId: number; path: string; type: 'file' | 'directory' };
      if (!rawPath || !type) return reply.status(400).send({ error: 'path and type are required' });
      if (/[\x00-\x1f]/.test(rawPath)) return reply.status(400).send({ error: 'Invalid path' });
      if (type !== 'file' && type !== 'directory') return reply.status(400).send({ error: 'type must be file or directory' });

      const ps = projectServerRepo.find(projectId, srv.name);
      if (!ps?.workingDirectory) return reply.status(400).send({ error: 'Project server has no working directory' });

      try {
        const transport = srv.type !== 'local' ? transportFactory.getTransport(srv) : undefined;
        const parentDir = path.dirname(rawPath);
        await assertDirectoryContained(resolverFactory, srv.type, transport, { target: parentDir, allowedRoot: ps.workingDirectory }, 'target path');
        await fileBrowseService.createEntry(srv, rawPath, type);
        return { ok: true };
      } catch (err: unknown) {
        if (err instanceof FileBrowseError) return reply.status(err.status).send({ error: err.message });
        const message = (err as Error).message;
        if (message.includes('escapes the allowed directory') || message.includes('Cannot verify')) {
          return reply.status(400).send({ error: message });
        }
        return reply.status(500).send({ error: message });
      }
    },
  );

  // ── DELETE /api/servers/:name/files (delete file/directory) ──
  fastify.delete<{ Params: { name: string }; Body: { projectId: number; path: string } }>(
    '/api/servers/:name/files',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const { projectId, path: rawPath } = request.body as { projectId: number; path: string };
      if (!rawPath) return reply.status(400).send({ error: 'path is required' });
      if (/[\x00-\x1f]/.test(rawPath)) return reply.status(400).send({ error: 'Invalid path' });

      if (path.basename(rawPath) === '.git') return reply.status(400).send({ error: 'Cannot delete .git directory' });

      const ps = projectServerRepo.find(projectId, srv.name);
      if (!ps?.workingDirectory) return reply.status(400).send({ error: 'Project server has no working directory' });

      try {
        const transport = srv.type !== 'local' ? transportFactory.getTransport(srv) : undefined;
        const parentDir = path.dirname(rawPath);
        const resolvedParent = await assertDirectoryContained(resolverFactory, srv.type, transport, { target: parentDir, allowedRoot: ps.workingDirectory }, 'target path');
        const resolver = resolverFactory.create(srv.type, transport);
        const resolvedRoot = await resolver.resolveRealPath(ps.workingDirectory);
        if (resolvedParent === resolvedRoot && path.basename(rawPath) === '.') {
          return reply.status(400).send({ error: 'Cannot delete the root directory' });
        }
        const resolvedTarget = path.join(resolvedParent, path.basename(rawPath));
        if (resolvedTarget === resolvedRoot) return reply.status(400).send({ error: 'Cannot delete the root directory' });

        await fileBrowseService.deleteEntry(srv, rawPath);
        return { ok: true };
      } catch (err: unknown) {
        if (err instanceof FileBrowseError) return reply.status(err.status).send({ error: err.message });
        const message = (err as Error).message;
        if (message.includes('escapes the allowed directory') || message.includes('Cannot verify')) {
          return reply.status(400).send({ error: message });
        }
        return reply.status(500).send({ error: message });
      }
    },
  );

  // ── PATCH /api/servers/:name/files (rename file/directory) ──
  fastify.patch<{ Params: { name: string }; Body: { projectId: number; path: string; newName: string } }>(
    '/api/servers/:name/files',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const { projectId, path: rawPath, newName } = request.body as { projectId: number; path: string; newName: string };
      if (!rawPath || !newName) return reply.status(400).send({ error: 'path and newName are required' });
      if (/[\x00-\x1f]/.test(rawPath) || /[\x00-\x1f]/.test(newName)) return reply.status(400).send({ error: 'Invalid path' });
      if (newName.includes('/') || newName.includes('\\')) return reply.status(400).send({ error: 'newName must not contain path separators' });

      const ps = projectServerRepo.find(projectId, srv.name);
      if (!ps?.workingDirectory) return reply.status(400).send({ error: 'Project server has no working directory' });

      try {
        const transport = srv.type !== 'local' ? transportFactory.getTransport(srv) : undefined;
        const parentDir = path.dirname(rawPath);
        await assertDirectoryContained(resolverFactory, srv.type, transport, { target: parentDir, allowedRoot: ps.workingDirectory }, 'source path');

        await fileBrowseService.renameEntry(srv, rawPath, newName);
        return { ok: true };
      } catch (err: unknown) {
        if (err instanceof FileBrowseError) return reply.status(err.status).send({ error: err.message });
        const message = (err as Error).message;
        if (message.includes('escapes the allowed directory') || message.includes('Cannot verify')) {
          return reply.status(400).send({ error: message });
        }
        return reply.status(500).send({ error: message });
      }
    },
  );

  // ── GET /api/servers/:name/files/search ──
  fastify.get<{ Params: { name: string }; Querystring: { q?: string; project_id?: string; root?: string; name?: string; content?: string; case?: string; regex?: string } }>(
    '/api/servers/:name/files/search',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const q = (request.query.q || '').trim();
      if (!q) return reply.status(400).send({ error: 'q is required' });
      if (q.length > 200) return reply.status(400).send({ error: 'q must be 200 characters or fewer' });
      if (/[\x00-\x1f]/.test(q)) return reply.status(400).send({ error: 'Invalid query' });

      const projectId = parseInt(request.query.project_id || '', 10);
      if (isNaN(projectId)) return reply.status(400).send({ error: 'project_id is required' });

      const matchName = request.query.name !== 'false';
      const matchContent = request.query.content !== 'false';
      if (!matchName && !matchContent) return reply.status(400).send({ error: 'At least one of name or content must be enabled' });

      const ps = projectServerRepo.find(projectId, srv.name);
      if (!ps?.workingDirectory) return reply.status(400).send({ error: 'Project server has no working directory' });

      let root = (request.query.root || '').trim() || ps.workingDirectory;
      if (/[\x00-\x1f]/.test(root)) return reply.status(400).send({ error: 'Invalid root path' });

      try {
        const transport = srv.type !== 'local' ? transportFactory.getTransport(srv) : undefined;
        root = await assertDirectoryContained(resolverFactory, srv.type, transport, { target: root, allowedRoot: ps.workingDirectory }, 'search root');
      } catch (err: unknown) {
        const message = (err as Error).message;
        if (message.includes('escapes the allowed directory') || message.includes('Cannot verify')) {
          return reply.status(400).send({ error: message });
        }
        return reply.status(500).send({ error: message });
      }

      try {
        const result = await searchService.search(srv, {
          query: q,
          root,
          matchName,
          matchContent,
          caseSensitive: request.query.case === 'true',
          regex: request.query.regex === 'true',
        });
        return result;
      } catch (err: unknown) {
        if (err instanceof FileBrowseError) return reply.status(err.status).send({ error: err.message });
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  done();
};

export default storageRoutes;
