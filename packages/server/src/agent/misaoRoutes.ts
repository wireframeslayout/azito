import type { FastifyPluginCallback } from 'fastify';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { agentMisaoRoot, readMisaoSocketStatus, type AgentMisaoHost, type AgentMisaoSocket } from '../modules/servers/transport/agentMisaoSocket';

/** The files a misao release is made of (the hub's `misao/` bundle). Nothing else can be uploaded. */
export const MISAO_UPLOAD_FILES = {
  'misao.mjs': 0o755,
  'LICENSES.txt': 0o644,
} as const;

export type MisaoUploadName = keyof typeof MISAO_UPLOAD_FILES;

/** An upload is one release file, a few MB; this is only a ceiling against a runaway body. */
export const MISAO_UPLOAD_LIMIT_BYTES = 64 * 1024 * 1024;

const VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface MisaoRoutesOptions {
  /** Null when the socket setting is unusable: the status says so and uploads are still possible (the layout is fixed). */
  socket: AgentMisaoSocket | null;
  host: AgentMisaoHost;
}

function isUploadName(value: unknown): value is MisaoUploadName {
  return typeof value === 'string' && Object.hasOwn(MISAO_UPLOAD_FILES, value);
}

/** Where an upload of `version` is staged: next to the final `<root>/<version>` directory, which the hub's installer moves it to. */
export function misaoStagingDir(homeDir: string, version: string): string {
  return path.join(agentMisaoRoot(homeDir), `${version}.upload`);
}

/**
 * The agent's side of installing misao: what it sees (`status`) and a place to put the release files (`upload`).
 * Everything else (node-pty, the service unit, starting it) is done by the hub through the agent's exec, which already
 * runs with the same token. Both routes sit behind the agent token check like every other /api route; the upload
 * writes only the two release files, only under `<home>/.azito/misao/<version>.upload/`, whatever the request says.
 */
const misaoRoutes: FastifyPluginCallback<MisaoRoutesOptions> = (fastify, opts, done) => {
  const { socket, host } = opts;

  fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MISAO_UPLOAD_LIMIT_BYTES }, (_request, body, next) => next(null, body));

  fastify.get('/api/misao/status', async (_request, reply) => {
    if (!socket) return reply.status(503).send({ error: 'misao relay disabled' });
    return readMisaoSocketStatus(socket, host);
  });

  fastify.put<{ Querystring: { version?: string; name?: string }; Body: Buffer }>('/api/misao/upload', async (request, reply) => {
    const { version, name } = request.query;
    if (typeof version !== 'string' || !VERSION_RE.test(version)) return reply.status(400).send({ error: 'version must be x.y.z' });
    if (!isUploadName(name)) return reply.status(400).send({ error: `name must be one of ${Object.keys(MISAO_UPLOAD_FILES).join(', ')}` });
    if (!Buffer.isBuffer(request.body)) return reply.status(415).send({ error: 'body must be application/octet-stream' });

    const root = agentMisaoRoot(host.homeDir);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the umask and ignored for an existing directory; the daemon refuses anything but 700.
    fs.chmodSync(root, 0o700);
    const stage = misaoStagingDir(host.homeDir, version);
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });

    const target = path.join(stage, name);
    const partial = `${target}.part`;
    fs.writeFileSync(partial, request.body, { mode: MISAO_UPLOAD_FILES[name] });
    fs.chmodSync(partial, MISAO_UPLOAD_FILES[name]);
    fs.renameSync(partial, target);
    return { name, size: request.body.length, sha256: crypto.createHash('sha256').update(request.body).digest('hex') };
  });

  done();
};

export default misaoRoutes;
