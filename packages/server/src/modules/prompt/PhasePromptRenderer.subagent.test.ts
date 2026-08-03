import { describe, it, expect } from 'vitest';
import { buildSubagentDelegationBlock, buildSubagentRulesFileContent } from './PhasePromptRenderer';
import type { SubagentConfig } from '../units/Unit';

const REVIEW_CONFIG: SubagentConfig = { enabled: true, provider: 'claude', model: 'claude-opus-4-5' };
const IMPLEMENT_CONFIG: SubagentConfig = { enabled: true, provider: 'openai', model: 'o3' };

const RULES_PATH = '/tmp/azito-rules-1-abc123.md';

const REVIEW_MODULES = {
  reviewPerspectives: '<review_perspectives>test review content</review_perspectives>',
  implementationRules: '<common>test common rules</common>',
};
const IMPLEMENT_MODULES = {
  softwareDesignPrinciples: '<software_design_principles>test design content</software_design_principles>',
  uiDesignPrinciples: '<ui_design_principles>test ui content</ui_design_principles>',
  implementationRules: '<common>test common rules</common>',
};

describe('buildSubagentRulesFileContent', () => {
  it('review content includes review perspectives and common rules', () => {
    const content = buildSubagentRulesFileContent('review', REVIEW_MODULES);
    expect(content).toContain(REVIEW_MODULES.reviewPerspectives);
    expect(content).toContain(REVIEW_MODULES.implementationRules);
  });

  it('implement content includes design principles, ui principles and common rules', () => {
    const content = buildSubagentRulesFileContent('implement', IMPLEMENT_MODULES);
    expect(content).toContain(IMPLEMENT_MODULES.softwareDesignPrinciples);
    expect(content).toContain(IMPLEMENT_MODULES.uiDesignPrinciples);
    expect(content).toContain(IMPLEMENT_MODULES.implementationRules);
  });

  it('omits the common rules section when implementationRules is empty', () => {
    const content = buildSubagentRulesFileContent('review', {
      reviewPerspectives: 'persp',
      implementationRules: '   ',
    });
    expect(content).not.toContain('共通実装ルール');
  });
});

describe('buildSubagentDelegationBlock', () => {
  it('returns a string containing provider and model for review role', () => {
    const result = buildSubagentDelegationBlock('review', REVIEW_CONFIG, 'generic', RULES_PATH);
    expect(result).toContain('claude');
    expect(result).toContain('claude-opus-4-5');
  });

  it('returns a string containing provider and model for implement role', () => {
    const result = buildSubagentDelegationBlock('implement', IMPLEMENT_CONFIG, 'generic', RULES_PATH);
    expect(result).toContain('openai');
    expect(result).toContain('o3');
  });

  it('references the rules file path instead of inlining rule text', () => {
    const result = buildSubagentDelegationBlock('implement', IMPLEMENT_CONFIG, 'generic', RULES_PATH);
    expect(result).toContain(RULES_PATH);
    // Rule body must NOT be embedded in the parent prompt anymore.
    expect(result).not.toContain(IMPLEMENT_MODULES.softwareDesignPrinciples);
    expect(result).not.toContain(IMPLEMENT_MODULES.implementationRules);
  });

  it('instructs the parent to make the subagent read the rules file first', () => {
    const result = buildSubagentDelegationBlock('review', REVIEW_CONFIG, 'generic', RULES_PATH);
    expect(result).toContain('最初に');
    expect(result).toContain(RULES_PATH);
  });

  it('review and implement roles return different blocks', () => {
    const reviewResult = buildSubagentDelegationBlock('review', REVIEW_CONFIG, 'generic', RULES_PATH);
    const implementResult = buildSubagentDelegationBlock('implement', REVIEW_CONFIG, 'generic', RULES_PATH);
    expect(reviewResult).not.toEqual(implementResult);
  });

  it('uses headless codex exec when workerType differs from provider', () => {
    const cfg: SubagentConfig = { enabled: true, provider: 'codex', model: 'gpt-5.5' };
    const result = buildSubagentDelegationBlock('review', cfg, 'claude', RULES_PATH);
    expect(result).toContain('codex exec');
    expect(result).toContain('gpt-5.5');
    expect(result).toContain('必ず');
    expect(result).not.toContain('codex --dangerously-bypass-approvals-and-sandbox');
  });

  it('uses native delegation when workerType matches provider for codex', () => {
    const cfg: SubagentConfig = { enabled: true, provider: 'codex', model: 'gpt-5.5' };
    const result = buildSubagentDelegationBlock('review', cfg, 'codex', RULES_PATH);
    expect(result).toContain('gpt-5.5');
    expect(result).toContain('必ず');
    expect(result).not.toContain('codex exec');
    expect(result).toContain('ネイティブ');
  });

  it('uses headless claude -p when workerType differs from claude provider', () => {
    const result = buildSubagentDelegationBlock('implement', REVIEW_CONFIG, 'codex', RULES_PATH);
    expect(result).toContain('claude -p');
    expect(result).toContain('claude-opus-4-5');
    expect(result).not.toContain('claude --dangerously-skip-permissions');
  });

  it('uses native delegation when workerType matches claude provider', () => {
    const result = buildSubagentDelegationBlock('implement', REVIEW_CONFIG, 'claude', RULES_PATH);
    expect(result).toContain('claude-opus-4-5');
    expect(result).not.toContain('claude -p');
    expect(result).toContain('ネイティブ');
  });
});

describe('delegation block injection behavior', () => {
  it('prompt is unchanged when config is null', () => {
    const basePrompt = 'Do the implementation work.';
    function applyDelegation(base: string, config: SubagentConfig | null, role: 'review' | 'implement'): string {
      if (config !== null && config.enabled === true) {
        return base + buildSubagentDelegationBlock(role, config, 'generic', RULES_PATH);
      }
      return base;
    }
    expect(applyDelegation(basePrompt, null, 'implement')).toBe(basePrompt);
  });

  it('prompt is unchanged when enabled is false', () => {
    const basePrompt = 'Do the review work.';
    const config: SubagentConfig = { enabled: false, provider: 'claude', model: 'claude-sonnet-4' };
    const result = config?.enabled === true
      ? basePrompt + buildSubagentDelegationBlock('review', config, 'generic', RULES_PATH)
      : basePrompt;
    expect(result).toBe(basePrompt);
  });

  it('delegation block is appended when enabled is true', () => {
    const basePrompt = 'Do the review work.';
    const config: SubagentConfig = { enabled: true, provider: 'claude', model: 'claude-opus-4-5' };
    const result = config?.enabled === true
      ? basePrompt + buildSubagentDelegationBlock('review', config, 'generic', RULES_PATH)
      : basePrompt;
    expect(result).not.toBe(basePrompt);
    expect(result.startsWith(basePrompt)).toBe(true);
    expect(result.length).toBeGreaterThan(basePrompt.length);
  });
});
