import { z } from 'zod';

const integer = z.string().regex(/^\d+$/).transform(Number).refine(Number.isSafeInteger);
const id = integer.refine((n) => n > 0);
const ids = z.string().transform((s) => s.split(',')).pipe(z.array(id).min(1)).transform((values) => [...new Set(values)]).refine((values) => values.length <= 50);
const since = z.string().transform((s) => s.split(',')).pipe(z.array(z.string().regex(/^\d+:\d+$/))).transform((pairs) => pairs.map((pair) => pair.split(':').map(Number))).refine((pairs) => pairs.every(([key, value]) => Number.isSafeInteger(key) && key > 0 && Number.isSafeInteger(value) && value >= 0) && new Set(pairs.map(([key]) => key)).size === pairs.length).transform((pairs) => new Map(pairs.map(([key, value]) => [key, value])));
export const windowSnapshotSchema = z.object({ ids, lines: integer.refine((n) => n >= 1 && n <= 60).default(12), since: since.optional() }).strict();
