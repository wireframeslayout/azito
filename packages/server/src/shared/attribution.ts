import { parseWindowId } from '@azito/shared';
import type { FastifyRequest } from 'fastify';
export interface Attribution { recordInteraction(callerWindowId: number, subject: { windowId: number } | { taskId: number }): void }
export function recordAttribution(request: FastifyRequest, attribution: Attribution, subject: { windowId: number } | { taskId: number }): void {
  const header = request.headers['x-azito-window-id'];
  const id = typeof header === 'string' ? parseWindowId(header) : null;
  if (id === null) return;
  try { attribution.recordInteraction(id, subject); }
  catch (err) { request.log.warn({ err }, 'Failed to record window attribution'); }
}
