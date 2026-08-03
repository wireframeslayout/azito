import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UnitTypeLoader, DEFAULT_BUILTIN_UNIT_TYPES_DIR } from './UnitTypeLoader';
import { parseUnitTypeToml } from './unitTypeSchema';
import type { PhaseSignalCapability } from '../prompt/executionEnvelope';

const EXPECTED_CAPABILITIES: Record<string, PhaseSignalCapability> = {
  planning: { questions: true, testFailed: false },
  implementing: { questions: true, testFailed: false },
  reviewing: { questions: false, testFailed: false },
  testing: { questions: false, testFailed: true },
  pushing: { questions: false, testFailed: false },
};

const EXPECTED_SKILL_COMMANDS: Record<string, string> = {
  planning: 'azt-plan',
  implementing: 'azt-implement',
  reviewing: 'azt-review',
  testing: 'azt-test',
  pushing: 'azt-push',
};

describe('devops.toml equivalence', () => {
  let loader: UnitTypeLoader;

  beforeEach(() => {
    loader = new UnitTypeLoader(DEFAULT_BUILTIN_UNIT_TYPES_DIR);
  });

  it('loads devops UnitType', () => {
    const devops = loader.getOrThrow('devops');
    expect(devops.name).toBe('devops');
    expect(devops.label).toBe('DevOps');
  });

  it('phase order matches expected devops phase order', () => {
    const devops = loader.getOrThrow('devops');
    const phaseNames = devops.phases.map((p) => p.name);
    expect(phaseNames).toEqual(['planning', 'implementing', 'reviewing', 'testing', 'pushing']);
  });

  it('signal capabilities match expected values per phase', () => {
    const devops = loader.getOrThrow('devops');
    for (const phase of devops.phases) {
      const expected = EXPECTED_CAPABILITIES[phase.name];
      expect(phase.questions).toBe(expected.questions);
      expect(phase.testFailed).toBe(expected.testFailed);
    }
  });

  it('skill commands match PHASE_SKILL_COMMANDS', () => {
    const devops = loader.getOrThrow('devops');
    for (const phase of devops.phases) {
      expect(phase.skillCommand).toBe(EXPECTED_SKILL_COMMANDS[phase.name]);
    }
  });

  it('planning has planApproval', () => {
    const devops = loader.getOrThrow('devops');
    const planning = devops.phases.find((p) => p.name === 'planning')!;
    expect(planning.planApproval).toBe(true);
  });

  it('reviewing has selfReviewRetry', () => {
    const devops = loader.getOrThrow('devops');
    const reviewing = devops.phases.find((p) => p.name === 'reviewing')!;
    expect(reviewing.selfReviewRetry).toBe(true);
  });

  it('testing has testFailedRollbackTo reviewing', () => {
    const devops = loader.getOrThrow('devops');
    const testing = devops.phases.find((p) => p.name === 'testing')!;
    expect(testing.testFailedRollbackTo).toBe('reviewing');
  });

  it('pushing has pushVerify', () => {
    const devops = loader.getOrThrow('devops');
    const pushing = devops.phases.find((p) => p.name === 'pushing')!;
    expect(pushing.pushVerify).toBe(true);
  });

  it('subagentRole matches expected phases', () => {
    const devops = loader.getOrThrow('devops');
    const implementing = devops.phases.find((p) => p.name === 'implementing')!;
    const reviewing = devops.phases.find((p) => p.name === 'reviewing')!;
    expect(implementing.subagentRole).toBe('implement');
    expect(reviewing.subagentRole).toBe('review');

    for (const phase of devops.phases) {
      if (phase.name !== 'implementing' && phase.name !== 'reviewing') {
        expect(phase.subagentRole).toBeUndefined();
      }
    }
  });

  it('non-applicable capabilities are false', () => {
    const devops = loader.getOrThrow('devops');
    for (const phase of devops.phases) {
      if (phase.name !== 'planning') expect(phase.planApproval).toBe(false);
      if (phase.name !== 'reviewing') expect(phase.selfReviewRetry).toBe(false);
      if (phase.name !== 'pushing') expect(phase.pushVerify).toBe(false);
    }
  });

  it('default tags equal [name] for each phase', () => {
    const devops = loader.getOrThrow('devops');
    for (const phase of devops.phases) {
      expect(phase.tags).toEqual([phase.name]);
    }
  });
});

describe('parseUnitTypeToml validation', () => {
  const minimal = (overrides: string) => `
name = "test"
label = "Test"
${overrides}
`;

  it('rejects duplicate phase names', () => {
    expect(() => parseUnitTypeToml(minimal(`
[[phases]]
name = "a"
[[phases]]
name = "a"
`))).toThrow(/[Dd]uplicate/);
  });

  it('rejects forward-reference testFailedRollbackTo', () => {
    expect(() => parseUnitTypeToml(minimal(`
[[phases]]
name = "a"
testFailedRollbackTo = "b"
[[phases]]
name = "b"
`))).toThrow(/earlier/);
  });

  it('rejects unknown subagentRole', () => {
    expect(() => parseUnitTypeToml(minimal(`
[[phases]]
name = "a"
subagentRole = "unknown"
`))).toThrow();
  });

  it('rejects empty phases', () => {
    expect(() => parseUnitTypeToml(`
name = "test"
label = "Test"
phases = []
`)).toThrow();
  });

  it('rejects invalid name pattern', () => {
    expect(() => parseUnitTypeToml(`
name = "Test With Spaces"
label = "Test"
[[phases]]
name = "a"
`)).toThrow();
  });
});

describe('UnitTypeLoader 2-layer merge', () => {
  let builtinDir: string;
  let userDir: string;
  let loader: UnitTypeLoader;

  beforeEach(() => {
    builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-builtin-'));
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-user-'));
    loader = new UnitTypeLoader(builtinDir, userDir);
  });

  afterEach(() => {
    fs.rmSync(builtinDir, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  function writeToml(dir: string, name: string, label: string): void {
    fs.writeFileSync(
      path.join(dir, `${name}.toml`),
      `name = "${name}"\nlabel = "${label}"\n[[phases]]\nname = "step1"\n`,
    );
  }

  it('user overrides builtin with same name', () => {
    writeToml(builtinDir, 'workflow', 'Builtin');
    writeToml(userDir, 'workflow', 'User Override');
    loader.invalidateCache();
    const list = loader.list();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('User Override');
  });

  it('includes user-only UnitTypes', () => {
    writeToml(builtinDir, 'base', 'Base');
    writeToml(userDir, 'custom', 'Custom');
    loader.invalidateCache();
    const list = loader.list();
    const names = list.map((u) => u.name);
    expect(names).toContain('base');
    expect(names).toContain('custom');
    expect(list).toHaveLength(2);
  });
});
