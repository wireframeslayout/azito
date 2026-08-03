import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import phasePromptsRoutes from './routes';
import type { SidekickPackageLoader } from '../sidekicks/SidekickPackageLoader';
import type { SidekickPackage } from '../sidekicks/SidekickPackage';
import type { TaskPhase } from '../sidekicks/TaskPhase';
import type { RenderSkillPromptUseCase } from './RenderSkillPromptUseCase';
import type { UnitTypeLoader } from '../sidekicks/UnitTypeLoader';
import type { UnitType, UnitTypePhase } from '../sidekicks/UnitType';

const DEVOPS_PHASES: UnitTypePhase[] = [
  { name: 'planning', label: 'Planning', tags: ['planning'], questions: true, testFailed: false, planApproval: true, selfReviewRetry: false, pushVerify: false, skillCommand: 'azt-plan' },
  { name: 'implementing', label: 'Implementing', tags: ['implementing'], questions: true, testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: false, subagentRole: 'implement', skillCommand: 'azt-implement' },
  { name: 'reviewing', label: 'Reviewing', tags: ['reviewing'], questions: false, testFailed: false, planApproval: false, selfReviewRetry: true, pushVerify: false, subagentRole: 'review', skillCommand: 'azt-review' },
  { name: 'testing', label: 'Testing', tags: ['testing'], questions: false, testFailed: true, planApproval: false, selfReviewRetry: false, pushVerify: false, testFailedRollbackTo: 'reviewing', skillCommand: 'azt-test' },
  { name: 'pushing', label: 'Pushing', tags: ['pushing'], questions: false, testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: true, skillCommand: 'azt-push' },
];
const DEVOPS_UNIT_TYPE: UnitType = { name: 'devops', label: 'DevOps', description: 'Standard 5-phase development workflow', phases: DEVOPS_PHASES };

const unitTypeLoader = { getOrThrow: () => DEVOPS_UNIT_TYPE, listNames: () => ['devops'] } as unknown as UnitTypeLoader;

function makeSidekick(phase: TaskPhase): SidekickPackage {
  return {
    name: `${phase}-default`,
    description: 'd',
    tags: [phase],
    isDefault: true,
    layer: 'builtin',
    overridesBuiltin: false,
    dir: `/harness/sidekicks/${phase}-default`,
    body: `${phase} body`,
    hasScripts: false,
    hasReferences: false,
  };
}

function makeLoader(opts: { missingPhases?: string[] } = {}): SidekickPackageLoader {
  return {
    list: () => [],
    findByName: () => null,
    findDefaultForTag: (tag: string) =>
      opts.missingPhases?.includes(tag) ? null : makeSidekick(tag as TaskPhase),
    invalidateCache: () => {},
  } as unknown as SidekickPackageLoader;
}

async function buildApp(loader: SidekickPackageLoader): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(phasePromptsRoutes, {
    sidekickLoader: loader,
    renderSkillPromptUseCase: { render: () => { throw new Error('not under test'); } } as unknown as RenderSkillPromptUseCase,
    unitTypeLoader,
  });
  await app.ready();
  return app;
}

describe('phasePromptsRoutes (synthesized compat view, Issue #263 Phase 5)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/phase-prompts synthesizes all 5 phases from their default Sidekick packages', async () => {
    app = await buildApp(makeLoader());
    const res = await app.inject({ method: 'GET', url: '/api/phase-prompts' });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(5);
    expect(list[0]).toMatchObject({ id: 1, phase: 'planning', prompt: 'planning body', enabled: true });
  });

  it('GET /api/phase-prompts fails fast (500) when a phase has no default Sidekick package', async () => {
    app = await buildApp(makeLoader({ missingPhases: ['testing'] }));
    const res = await app.inject({ method: 'GET', url: '/api/phase-prompts' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('No default Sidekick package is configured for phase "testing"');
  });

  it('GET /api/phase-prompts/:phase fails fast (500) when the phase default is missing', async () => {
    app = await buildApp(makeLoader({ missingPhases: ['pushing'] }));
    const res = await app.inject({ method: 'GET', url: '/api/phase-prompts/pushing' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('No default Sidekick package is configured for phase "pushing"');
  });

  it('GET /api/phase-prompts/:phase returns the synthesized single-phase shape', async () => {
    app = await buildApp(makeLoader());
    const res = await app.inject({ method: 'GET', url: '/api/phase-prompts/reviewing' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 3, phase: 'reviewing', prompt: 'reviewing body' });
  });

  it('PUT /api/phase-prompts/:phase returns 410 Gone', async () => {
    app = await buildApp(makeLoader());
    const res = await app.inject({ method: 'PUT', url: '/api/phase-prompts/planning', payload: { prompt: 'x' } });
    expect(res.statusCode).toBe(410);
  });
});
