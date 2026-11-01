import { z } from 'zod';

export const directionBody = z.strictObject({ direction: z.string().optional() });
export const nameBody = z.strictObject({ name: z.string().optional() });
export const titleBody = z.strictObject({ title: z.string().optional() });
export const keysBody = z.strictObject({ keys: z.array(z.string()).optional() });
export const paneBody = z.strictObject({ ordinal: z.number().optional(), direction: z.string().optional() });
export const commandBody = z.strictObject({ command: z.string().optional() });
export const refBody = z.strictObject({ ref: z.string().optional() });
export const workspaceRenameBody = z.strictObject({ name: z.string().optional(), kind: z.unknown().optional() });
