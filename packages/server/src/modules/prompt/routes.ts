import type { FastifyPluginCallback } from 'fastify';
import type { RenderSkillPromptUseCase } from './RenderSkillPromptUseCase';
import type { SidekickPackageLoader } from '../sidekicks/SidekickPackageLoader';
import { resolvePhaseSidekick } from '../sidekicks/resolvePhaseSidekick';
import { isPhaseTag, type TaskPhase } from '../sidekicks/TaskPhase';
import type { UnitTypeLoader } from '../sidekicks/UnitTypeLoader';
import type { UnitTypePhase } from '../sidekicks/UnitType';

// ─── Types ───

export interface PhasePromptsRouteOptions {
  sidekickLoader: SidekickPackageLoader;
  renderSkillPromptUseCase: RenderSkillPromptUseCase;
  unitTypeLoader: UnitTypeLoader;
}

/**
 * Read-only shape kept for frontend/back-compat (PhasePrompts.tsx settings
 * screen, TaskLogView.tsx follow-up phase picker) after the phase_prompts
 * table was dropped (Issue #263 Phase 5). Synthesized from each phase's
 * default Sidekick package rather than stored in the DB — there is no
 * meaningful *global* enabled/id anymore (that's per-Operation via
 * operations.phase_config), so `id`/`order` are just the UnitType phase
 * position and `enabled` is always true here.
 */
interface SynthesizedPhasePrompt {
  id: number;
  phase: TaskPhase;
  prompt: string;
  order: number;
  enabled: boolean;
  updatedAt: string;
}

/**
 * Fail-fast like the execution path: uses the same resolvePhaseSidekick rule
 * (no phaseConfig = phase default), so a missing default package throws a
 * clear error instead of silently returning an empty prompt.
 */
function synthesizePhasePrompt(loader: SidekickPackageLoader, phaseDef: UnitTypePhase, order: number): SynthesizedPhasePrompt {
  if (!isPhaseTag(phaseDef.name)) throw new Error(`Phase "${phaseDef.name}" is not a known phase tag`);
  const phase = phaseDef.name;
  const pkg = resolvePhaseSidekick(loader, phase, null, phaseDef);
  return {
    id: order,
    phase,
    prompt: pkg.body,
    order,
    enabled: true,
    updatedAt: '',
  };
}

// ─── Plugin ───

const phasePromptsRoutes: FastifyPluginCallback<PhasePromptsRouteOptions> = (fastify, opts, done) => {
  const { sidekickLoader, renderSkillPromptUseCase, unitTypeLoader } = opts;

  // ── GET /api/phase-prompts ── read-only, synthesized from each phase's default Sidekick package
  fastify.get('/api/phase-prompts', async (_request, reply) => {
    try {
      const unitType = unitTypeLoader.getOrThrow('devops');
      return unitType.phases.map((phase, i) => synthesizePhasePrompt(sidekickLoader, phase, i + 1));
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── GET /api/phase-prompts/:phase ──
  fastify.get<{ Params: { phase: string }; Querystring: { render?: string; task_id?: string } }>(
    '/api/phase-prompts/:phase',
    async (request, reply) => {
      const phaseParam = request.params.phase;
      const { render, task_id } = request.query;

      try {
        const unitType = unitTypeLoader.getOrThrow('devops');
        const phaseIndex = unitType.phases.findIndex((p) => p.name === phaseParam);
        const phaseDef = phaseIndex >= 0 ? unitType.phases[phaseIndex] : undefined;

        if (render === 'skill') {
          if (!phaseDef) {
            return reply.status(404).send({ error: 'Phase not found' });
          }
          if (!task_id) {
            return reply.status(400).send({ error: 'task_id is required when render=skill' });
          }
          const taskId = parseInt(task_id, 10);
          if (isNaN(taskId)) {
            return reply.status(400).send({ error: 'task_id must be a number' });
          }
          if (!isPhaseTag(phaseDef.name)) {
            return reply.status(404).send({ error: 'Phase not found' });
          }
          return await renderSkillPromptUseCase.render(phaseDef.name, taskId);
        }

        // Default: read-only synthesized view (backward compatible shape)
        if (!phaseDef) {
          return reply.status(404).send({ error: 'Phase not found' });
        }
        return synthesizePhasePrompt(sidekickLoader, phaseDef, phaseIndex + 1);
      } catch (err: unknown) {
        const message = (err as Error).message;
        if (message.startsWith('Task not found') || message.startsWith('Project not found')) {
          return reply.status(404).send({ error: message });
        }
        return reply.status(500).send({ error: message });
      }
    },
  );

  // ── PUT /api/phase-prompts/:phase ── 410 Gone: editing moved to Sidekick packages (Issue #263 Phase 5)
  fastify.put<{ Params: { phase: string } }>(
    '/api/phase-prompts/:phase',
    async (_request, reply) => {
      return reply.status(410).send({
        error: 'Editing phase prompts directly is no longer supported. Edit the phase\'s Sidekick package via /api/sidekicks instead.',
      });
    },
  );

  done();
};

export default phasePromptsRoutes;
