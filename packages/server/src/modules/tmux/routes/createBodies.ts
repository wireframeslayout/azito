import { z } from 'zod';

/**
 * Request bodies of the routes that create a session / workspace / window. Each is strict: a field the route does not
 * know (a typo such as `windowName` where the route takes `name`) is a 400 naming it, never silently dropped.
 * `kind` and `launch` stay `unknown` here: their own validators (`creationMuxKind`, `parseNewWindowLaunch`) own those errors.
 */

/** POST /api/servers/:name/mux/workspaces */
export const createWorkspaceBody = z.strictObject({
  name: z.string().optional(),
  windowName: z.string().optional(),
  force: z.boolean().optional(),
  kind: z.unknown().optional(),
  launch: z.unknown().optional(),
});

/** POST /api/servers/:name/mux/workspaces/:workspace/windows */
export const createMuxWindowBody = z.strictObject({
  name: z.string().optional(),
  force: z.boolean().optional(),
  kind: z.unknown().optional(),
  launch: z.unknown().optional(),
});

/** POST /api/servers/:name/sessions */
export const createSessionBody = z.strictObject({
  name: z.string().optional(),
  command: z.string().optional(),
  windowName: z.string().optional(),
  force: z.boolean().optional(),
});

/** POST /api/servers/:name/sessions/:session/windows */
export const createSessionWindowBody = z.strictObject({
  name: z.string().optional(),
  force: z.boolean().optional(),
});

export type StrictBodyFailure =
  | { error: 'unknown_fields'; unknown: string[]; accepted: string[] }
  | { error: 'invalid_body'; issues: Array<{ path: string; message: string }> };

export type StrictBodyResult<T> = { ok: true; data: T } | { ok: false; body: StrictBodyFailure };

/** An absent body is an empty one. Unknown fields answer `unknown_fields` with the accepted names; any other mismatch answers `invalid_body`. */
export function parseStrictBody<S extends z.ZodObject>(schema: S, body: unknown): StrictBodyResult<z.infer<S>> {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return { ok: true, data: parsed.data };
  const unknown = parsed.error.issues.flatMap((issue) => (issue.code === 'unrecognized_keys' ? issue.keys : []));
  if (unknown.length > 0) return { ok: false, body: { error: 'unknown_fields', unknown, accepted: Object.keys(schema.shape) } };
  return { ok: false, body: { error: 'invalid_body', issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } };
}
