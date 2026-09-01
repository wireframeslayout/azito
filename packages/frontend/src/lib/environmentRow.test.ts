import { describe, it, expect } from 'vitest';
import {
  buildEnvironmentRowChips,
  needsDistributionSetup,
  resolveDistributionChip,
  type DistributionPrerequisiteStage,
  type LastDistribution,
} from './environmentRow';

const LAST: LastDistribution = {
  distributedAt: '2026-08-30T10:00:00Z',
  bundleType: 'incremental',
  lastDistributedSha: 'a'.repeat(40),
};

describe('resolveDistributionChip', () => {
  it('shows no chip when distribution does not apply to this pairing', () => {
    expect(resolveDistributionChip({ status: 'not_required', stage: null }, null)).toBeNull();
  });

  it('shows a neutral "cannot be determined" chip for unknown', () => {
    expect(resolveDistributionChip({ status: 'unknown', stage: null }, null)).toEqual({
      id: 'distribution',
      tone: 'default',
      labelKey: 'settings.servers.distribution.unknown',
    });
  });

  it('shows a warning "not distributed yet" chip when prerequisites pass but nothing was distributed', () => {
    expect(resolveDistributionChip({ status: 'ok', stage: null }, null)).toEqual({
      id: 'distribution',
      tone: 'orange',
      labelKey: 'settings.servers.distribution.notDistributed',
    });
  });

  it('shows a success chip carrying the timestamp and bundle type once distributed', () => {
    expect(resolveDistributionChip({ status: 'ok', stage: null }, LAST)).toEqual({
      id: 'distribution',
      tone: 'green',
      labelKey: 'settings.servers.distribution.distributed',
      distributedAt: '2026-08-30T10:00:00Z',
      bundleKey: 'settings.servers.distribution.bundleIncremental',
    });
  });

  it('distinguishes a full bundle from an incremental one', () => {
    const chip = resolveDistributionChip({ status: 'ok', stage: null }, { ...LAST, bundleType: 'full' });
    expect(chip?.bundleKey).toBe('settings.servers.distribution.bundleFull');
  });

  const stages: Array<[DistributionPrerequisiteStage, string]> = [
    ['service_not_wired', 'settings.servers.distribution.failed.serviceNotWired'],
    ['no_working_dir', 'settings.servers.distribution.failed.noWorkingDir'],
    ['no_distribution_repository', 'settings.servers.distribution.failed.noDistributionRepository'],
    ['distribution_repository_not_found', 'settings.servers.distribution.failed.distributionRepositoryNotFound'],
    ['no_token', 'settings.servers.distribution.failed.noToken'],
    ['credential_unreadable', 'settings.servers.distribution.failed.credentialUnreadable'],
    ['identity_unresolvable', 'settings.servers.distribution.failed.identityUnresolvable'],
  ];

  for (const [stage, labelKey] of stages) {
    it(`maps the failed stage ${stage} to its own danger-toned label`, () => {
      expect(resolveDistributionChip({ status: 'failed', stage }, null)).toEqual({
        id: 'distribution',
        tone: 'red',
        labelKey,
      });
    });
  }

  it('never leaks the raw stage identifier into the label key set', () => {
    for (const [stage, labelKey] of stages) {
      expect(labelKey).not.toContain(stage);
    }
  });

  it('falls back to a generic danger label when a failure carries no stage', () => {
    expect(resolveDistributionChip({ status: 'failed', stage: null }, null)).toEqual({
      id: 'distribution',
      tone: 'red',
      labelKey: 'settings.servers.distribution.failedGeneric',
    });
  });

  it('keeps the failure visible even when an older successful distribution exists', () => {
    const chip = resolveDistributionChip({ status: 'failed', stage: 'no_token' }, LAST);
    expect(chip?.tone).toBe('red');
  });

  it('shows nothing when the row carries no prerequisite at all', () => {
    expect(resolveDistributionChip(undefined, null)).toBeNull();
  });
});

describe('needsDistributionSetup', () => {
  it('is true only for a failed prerequisite', () => {
    expect(needsDistributionSetup({ status: 'failed', stage: 'no_distribution_repository' })).toBe(true);
    expect(needsDistributionSetup({ status: 'ok', stage: null })).toBe(false);
    expect(needsDistributionSetup({ status: 'not_required', stage: null })).toBe(false);
    expect(needsDistributionSetup({ status: 'unknown', stage: null })).toBe(false);
    expect(needsDistributionSetup(undefined)).toBe(false);
  });
});

describe('buildEnvironmentRowChips', () => {
  it('orders the chips urgent -> context -> detail', () => {
    const chips = buildEnvironmentRowChips({
      branch: 'feat/x',
      inputPolicy: 'allow',
      isolated: true,
      distributionPrerequisite: { status: 'failed', stage: 'no_distribution_repository' },
      lastDistribution: null,
    });
    expect(chips.map((c) => c.id)).toEqual(['distribution', 'isolated', 'branch', 'inputPolicy']);
  });

  it('omits the distribution and isolated chips when neither applies', () => {
    const chips = buildEnvironmentRowChips({
      isolated: false,
      distributionPrerequisite: { status: 'not_required', stage: null },
      lastDistribution: null,
    });
    expect(chips.map((c) => c.id)).toEqual(['inputPolicy']);
  });

  it('omits the branch chip when no branch is configured', () => {
    const chips = buildEnvironmentRowChips({ isolated: false, branch: '' });
    expect(chips.some((c) => c.id === 'branch')).toBe(false);
  });

  it('changes the distribution chip with the presence of a last-distribution record', () => {
    const base = { isolated: false, distributionPrerequisite: { status: 'ok' as const, stage: null } };
    const never = buildEnvironmentRowChips({ ...base, lastDistribution: null });
    const once = buildEnvironmentRowChips({ ...base, lastDistribution: LAST });
    expect(never[0].labelKey).toBe('settings.servers.distribution.notDistributed');
    expect(never[0].tone).toBe('orange');
    expect(once[0].labelKey).toBe('settings.servers.distribution.distributed');
    expect(once[0].tone).toBe('green');
    expect(once[0].distributedAt).toBe(LAST.distributedAt);
  });

  it('warns only for the "allow" input policy', () => {
    const tone = (policy: 'deny' | 'manual-approval' | 'allow' | undefined) =>
      buildEnvironmentRowChips({ isolated: false, inputPolicy: policy }).find((c) => c.id === 'inputPolicy');
    expect(tone('allow')).toEqual({ id: 'inputPolicy', tone: 'orange', labelKey: 'settings.servers.inputPolicyAllow' });
    expect(tone('deny')).toEqual({ id: 'inputPolicy', tone: 'default', labelKey: 'settings.servers.inputPolicyDeny' });
    expect(tone('manual-approval')?.tone).toBe('default');
    // 未設定はサーバー側のフォールバックと同じく manual-approval 扱い。
    expect(tone(undefined)?.labelKey).toBe('settings.servers.inputPolicyManualApproval');
  });

  it('never puts the tmux session on a row chip', () => {
    const chips = buildEnvironmentRowChips({
      branch: 'main',
      inputPolicy: 'manual-approval',
      isolated: true,
      distributionPrerequisite: { status: 'ok', stage: null },
      lastDistribution: LAST,
    });
    const serialized = JSON.stringify(chips);
    expect(serialized).not.toContain('tmux');
    expect(serialized).not.toContain('session');
    expect(chips.some((c) => c.id === ('tmuxSession' as never))).toBe(false);
  });
});
