import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SidekickPackageLoader } from './SidekickPackageLoader';
import { resolvePhaseSidekick, isPhaseEnabled, resolveEnabledPhases, resolveNextPhase } from './resolvePhaseSidekick';
import type { UnitTypePhase } from './UnitType';

const DEVOPS_PHASES: UnitTypePhase[] = [
  { name: 'planning', label: 'Planning', tags: ['planning'], questions: true, testFailed: false, planApproval: true, selfReviewRetry: false, pushVerify: false, skillCommand: 'azt-plan' },
  { name: 'implementing', label: 'Implementing', tags: ['implementing'], questions: true, testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: false, subagentRole: 'implement', skillCommand: 'azt-implement' },
  { name: 'reviewing', label: 'Reviewing', tags: ['reviewing'], questions: false, testFailed: false, planApproval: false, selfReviewRetry: true, pushVerify: false, subagentRole: 'review', skillCommand: 'azt-review' },
  { name: 'testing', label: 'Testing', tags: ['testing'], questions: false, testFailed: true, planApproval: false, selfReviewRetry: false, pushVerify: false, testFailedRollbackTo: 'reviewing', skillCommand: 'azt-test' },
  { name: 'pushing', label: 'Pushing', tags: ['pushing'], questions: false, testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: true, skillCommand: 'azt-push' },
];

function writePackage(
  rootDir: string,
  name: string,
  opts: { phase?: string; isDefault?: boolean; description?: string; body?: string; frontmatterName?: string } = {},
): void {
  const dir = path.join(rootDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    `name: ${opts.frontmatterName ?? name}`,
    `description: ${opts.description ?? `${name} description`}`,
    `phase: ${opts.phase ?? 'planning'}`,
    `isDefault: ${opts.isDefault ?? false}`,
    '---',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `${fm}\n${opts.body ?? `${name} body`}`);
}

describe('resolvePhaseSidekick', () => {
  let builtinDir: string;
  let userDir: string;
  let loader: SidekickPackageLoader;

  beforeEach(() => {
    builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-builtin-'));
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-user-'));
    writePackage(builtinDir, 'planning-default', { phase: 'planning', isDefault: true, body: 'default planning body' });
    writePackage(builtinDir, 'planning-alt', { phase: 'planning', isDefault: false, body: 'alt planning body' });
    writePackage(builtinDir, 'my-standalone', { phase: 'standalone', isDefault: false, body: 'standalone body' });
    loader = new SidekickPackageLoader(builtinDir, userDir);
  });

  afterEach(() => {
    fs.rmSync(builtinDir, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  it('resolves the phase default when no override is configured', () => {
    const pkg = resolvePhaseSidekick(loader, 'planning', null, DEVOPS_PHASES.find(p => p.name === 'planning')!);
    expect(pkg.name).toBe('planning-default');
  });

  it('resolves a named override that matches the phase', () => {
    const pkg = resolvePhaseSidekick(loader, 'planning', { planning: { sidekick: 'planning-alt' } }, DEVOPS_PHASES.find(p => p.name === 'planning')!);
    expect(pkg.name).toBe('planning-alt');
  });

  it('fails fast when the configured override does not exist', () => {
    expect(() => resolvePhaseSidekick(loader, 'planning', { planning: { sidekick: 'does-not-exist' } }, DEVOPS_PHASES.find(p => p.name === 'planning')!))
      .toThrow('Sidekick "does-not-exist" configured for phase "planning" was not found');
  });

  it('fails fast when the configured override is for a different/standalone phase', () => {
    expect(() => resolvePhaseSidekick(loader, 'planning', { planning: { sidekick: 'my-standalone' } }, DEVOPS_PHASES.find(p => p.name === 'planning')!))
      .toThrow('cannot be assigned to the "planning" phase');
  });

  it('fails fast when no default package is configured for a phase', () => {
    expect(() => resolvePhaseSidekick(loader, 'implementing', null, DEVOPS_PHASES.find(p => p.name === 'implementing')!))
      .toThrow('No default Sidekick package is configured for phase "implementing"');
  });

  it('resolves an override that has multiple tags including the target phase', () => {
    const dir = path.join(builtinDir, 'multi-tag');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: multi-tag\ndescription: d\ntags: implementing, reviewing\nisDefault: false\n---\nbody',
    );
    loader.invalidateCache();
    const pkg = resolvePhaseSidekick(loader, 'reviewing', { reviewing: { sidekick: 'multi-tag' } }, DEVOPS_PHASES.find(p => p.name === 'reviewing')!);
    expect(pkg.name).toBe('multi-tag');
  });

  it('fails fast with a message pointing at the missing phase tag', () => {
    expect(() => resolvePhaseSidekick(loader, 'planning', { planning: { sidekick: 'my-standalone' } }, DEVOPS_PHASES.find(p => p.name === 'planning')!))
      .toThrow(/tags に一致するものが必要/);
  });

  describe('isPhaseEnabled / resolveEnabledPhases / resolveNextPhase', () => {
    it('treats an unset phaseConfig as fully enabled', () => {
      expect(isPhaseEnabled(null, 'testing')).toBe(true);
      expect(resolveEnabledPhases(null, DEVOPS_PHASES)).toEqual(['planning', 'implementing', 'reviewing', 'testing', 'pushing']);
    });

    it('treats an omitted enabled flag as enabled', () => {
      expect(isPhaseEnabled({ testing: { sidekick: 'x' } }, 'testing')).toBe(true);
    });

    it('excludes a phase with enabled: false', () => {
      expect(isPhaseEnabled({ testing: { enabled: false } }, 'testing')).toBe(false);
      expect(resolveEnabledPhases({ testing: { enabled: false } }, DEVOPS_PHASES)).toEqual(['planning', 'implementing', 'reviewing', 'pushing']);
    });

    it('resolves the next enabled phase, skipping disabled ones', () => {
      expect(resolveNextPhase({ testing: { enabled: false } }, 'reviewing', DEVOPS_PHASES)).toBe('pushing');
    });

    it('returns null when the current phase is last among enabled phases', () => {
      expect(resolveNextPhase(null, 'pushing', DEVOPS_PHASES)).toBeNull();
      expect(resolveNextPhase({ pushing: { enabled: false }, testing: { enabled: false } }, 'reviewing', DEVOPS_PHASES)).toBeNull();
    });
  });
});
