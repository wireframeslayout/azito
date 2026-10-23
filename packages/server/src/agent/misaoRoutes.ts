import type { FastifyPluginCallback } from 'fastify';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { MISAO_RELEASE_FILES, misaoFileNameOn, misaoRootOf, readMisaoSocketStatus, type AgentMisaoHost, type AgentMisaoSocket, type MisaoReleaseFile } from '../modules/servers/transport/agentMisaoSocket';

export type MisaoUploadName = MisaoReleaseFile;

/** An upload is one release file, a few MB; this is only a ceiling against a runaway body. */
export const MISAO_UPLOAD_LIMIT_BYTES = 64 * 1024 * 1024;

const VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface MisaoRoutesOptions {
  /** Null when the socket setting is unusable: the status says so and uploads are still possible (the layout is fixed). */
  socket: AgentMisaoSocket | null;
  host: AgentMisaoHost;
}

function isUploadName(value: unknown): value is MisaoUploadName {
  return typeof value === 'string' && Object.hasOwn(MISAO_RELEASE_FILES, value);
}

/** Where an upload of `version` is staged: next to the final `<root>/<version>` directory, which the hub's installer moves it to. */
export function misaoStagingDir(host: AgentMisaoHost, version: string): string {
  const pathApi = host.platform === 'win32' ? path.win32 : path;
  return pathApi.join(misaoRootOf(host), `${version}.upload`);
}

/**
 * The agent's side of installing misao: what it sees (`status`) and a place to put the release files (`upload`).
 * Everything else (node-pty, the service unit, starting it) is done by the hub through the agent's exec, which already
 * runs with the same token. Both routes sit behind the agent token check like every other /api route; the upload
 * writes only the release files (the binary and its licenses), only under `<misao folder>/<version>.upload/` (`<home>/.azito/misao` on Unix), whatever the request says.
 */
const misaoRoutes: FastifyPluginCallback<MisaoRoutesOptions> = (fastify, opts, done) => {
  const { socket, host } = opts;

  fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MISAO_UPLOAD_LIMIT_BYTES }, (_request, body, next) => next(null, body));

  fastify.get('/api/misao/status', async (_request, reply) => {
    if (!socket) return reply.status(503).send({ error: 'misao relay disabled' });
    return await readMisaoSocketStatus(socket, host);
  });

  fastify.put<{ Querystring: { version?: string; name?: string }; Body: Buffer }>('/api/misao/upload', async (request, reply) => {
    const { version, name } = request.query;
    if (typeof version !== 'string' || !VERSION_RE.test(version)) return reply.status(400).send({ error: 'version must be x.y.z' });
    if (!isUploadName(name)) return reply.status(400).send({ error: `name must be one of ${Object.keys(MISAO_RELEASE_FILES).join(', ')}` });
    if (!Buffer.isBuffer(request.body)) return reply.status(415).send({ error: 'body must be application/octet-stream' });

    const windows = host.platform === 'win32';
    const pathApi = windows ? path.win32 : path;
    const root = misaoRootOf(host);
    // Modes mean nothing on Windows (its folders are protected by the installer's ACL step), and chmod there only toggles read-only.
    fs.mkdirSync(root, { recursive: true, ...(windows ? {} : { mode: 0o700 }) });
    // mkdir's mode is masked by the umask and ignored for an existing directory; the daemon refuses anything but 700.
    if (!windows) fs.chmodSync(root, 0o700);
    const stage = misaoStagingDir(host, version);
    fs.mkdirSync(stage, { recursive: true, ...(windows ? {} : { mode: 0o700 }) });

    const target = pathApi.join(stage, misaoFileNameOn(host.platform, name));
    const partial = `${target}.part`;
    fs.writeFileSync(partial, request.body, windows ? {} : { mode: MISAO_RELEASE_FILES[name] });
    if (!windows) fs.chmodSync(partial, MISAO_RELEASE_FILES[name]);
    fs.renameSync(partial, target);
    return { name, size: request.body.length, sha256: crypto.createHash('sha256').update(request.body).digest('hex') };
  });

  done();
};

export default misaoRoutes;
