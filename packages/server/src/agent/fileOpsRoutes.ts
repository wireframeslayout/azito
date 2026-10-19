import type { FastifyPluginCallback } from 'fastify';
import type { IFileOps } from '../shared/fs/fileOps';
import { AGENT_FILE_OPS_PATH, FILE_OPS_BODY_LIMIT, executeFileOp, fileOpRequestSchema } from '../shared/fs/fileOpsWire';

export interface FileOpsRoutesOptions {
  /** The agent's own files, built once at startup from its host environment. */
  ops: IFileOps;
}

/**
 * File operations on the agent's host (list / stat / read / write / create / remove / rename / realpath / which / tmpPath), the
 * same functions the hub runs for its own server. Registered after the token check like every /api route. The request is
 * validated here; how an operation ended, a refusal included, is in the body (HTTP 200), and only a malformed request is 400.
 */
const fileOpsRoutes: FastifyPluginCallback<FileOpsRoutesOptions> = (fastify, opts, done) => {
  fastify.post(AGENT_FILE_OPS_PATH, { bodyLimit: FILE_OPS_BODY_LIMIT }, async (request, reply) => {
    const parsed = fileOpRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_file_op', message: parsed.error.message });
    return executeFileOp(opts.ops, parsed.data);
  });
  done();
};

export default fileOpsRoutes;
