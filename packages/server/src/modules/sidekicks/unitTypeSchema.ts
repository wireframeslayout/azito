// smol-toml is ESM-only; static import fails tsc under Node16/CJS resolution.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parse } = require('smol-toml') as { parse: (raw: string) => Record<string, unknown> };
import { z } from 'zod';
import type { UnitType, UnitTypePhase } from './UnitType';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const unitTypePhaseSchema = z.object({
  name: z.string().regex(NAME_PATTERN),
  label: z.string().optional(),
  tags: z.array(z.string().regex(NAME_PATTERN)).optional(),
  questions: z.boolean().default(false),
  testFailed: z.boolean().default(false),
  planApproval: z.boolean().default(false),
  selfReviewRetry: z.boolean().default(false),
  testFailedRollbackTo: z.string().optional(),
  pushVerify: z.boolean().default(false),
  subagentRole: z.enum(['implement', 'review']).optional(),
  skillCommand: z.string().optional(),
  defaultSidekick: z.string().optional(),
});

const unitTypeSchema = z.object({
  name: z.string().regex(NAME_PATTERN),
  label: z.string(),
  description: z.string().optional(),
  phases: z.array(unitTypePhaseSchema).min(1),
}).superRefine((val, ctx) => {
  const names = val.phases.map((p) => p.name);
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate phase name "${name}"`,
        path: ['phases'],
      });
    }
    seen.add(name);
  }

  for (let i = 0; i < val.phases.length; i++) {
    const rollbackTo = val.phases[i].testFailedRollbackTo;
    if (rollbackTo === undefined) continue;
    const targetIdx = names.indexOf(rollbackTo);
    if (targetIdx === -1 || targetIdx >= i) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `testFailedRollbackTo "${rollbackTo}" must reference an earlier phase`,
        path: ['phases', i, 'testFailedRollbackTo'],
      });
    }
  }
});

export function parseUnitTypeToml(raw: string): UnitType {
  const parsed = parse(raw);
  const validated = unitTypeSchema.parse(parsed);

  const phases: UnitTypePhase[] = validated.phases.map((p) => ({
    ...p,
    label: p.label ?? p.name,
    tags: p.tags ?? [p.name],
  }));

  return {
    name: validated.name,
    label: validated.label,
    description: validated.description,
    phases,
  };
}
