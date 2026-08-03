import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadPromptModules } from './PromptModuleLoader';

describe('loadPromptModules', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-modules-test-'));
    fs.writeFileSync(path.join(tmpDir, 'review-perspectives.md'), '<review_perspectives>review content</review_perspectives>');
    fs.writeFileSync(path.join(tmpDir, 'software-design-principles.md'), '<software_design_principles>design content</software_design_principles>');
    fs.writeFileSync(path.join(tmpDir, 'ui-design-principles.md'), '<ui_design_principles>ui content</ui_design_principles>');
    const rulesDir = path.join(tmpDir, 'rules');
    fs.mkdirSync(rulesDir);
    fs.writeFileSync(path.join(rulesDir, 'common.md'), 'common rules');
    fs.writeFileSync(path.join(rulesDir, 'typescript.md'), 'typescript rules');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns all three modules from the given directory', () => {
    const modules = loadPromptModules(tmpDir);
    expect(modules.reviewPerspectives).toBe('<review_perspectives>review content</review_perspectives>');
    expect(modules.softwareDesignPrinciples).toBe('<software_design_principles>design content</software_design_principles>');
    expect(modules.uiDesignPrinciples).toBe('<ui_design_principles>ui content</ui_design_principles>');
  });

  it('concatenates rules/*.md (sorted) into implementationRules', () => {
    const modules = loadPromptModules(tmpDir);
    // common.md sorts before typescript.md
    expect(modules.implementationRules).toBe('common rules\n\ntypescript rules');
  });

  it('returns empty implementationRules when the rules directory is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-modules-norules-'));
    try {
      fs.writeFileSync(path.join(dir, 'review-perspectives.md'), 'r');
      fs.writeFileSync(path.join(dir, 'software-design-principles.md'), 's');
      fs.writeFileSync(path.join(dir, 'ui-design-principles.md'), 'u');
      expect(loadPromptModules(dir).implementationRules).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when review-perspectives.md is missing', () => {
    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-modules-missing-'));
    try {
      fs.writeFileSync(path.join(missingDir, 'software-design-principles.md'), 'x');
      fs.writeFileSync(path.join(missingDir, 'ui-design-principles.md'), 'x');
      // review-perspectives.md intentionally absent
      expect(() => loadPromptModules(missingDir)).toThrow('Prompt module not found');
    } finally {
      fs.rmSync(missingDir, { recursive: true, force: true });
    }
  });

  it('throws when software-design-principles.md is missing', () => {
    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-modules-missing-'));
    try {
      fs.writeFileSync(path.join(missingDir, 'review-perspectives.md'), 'x');
      fs.writeFileSync(path.join(missingDir, 'ui-design-principles.md'), 'x');
      expect(() => loadPromptModules(missingDir)).toThrow('Prompt module not found');
    } finally {
      fs.rmSync(missingDir, { recursive: true, force: true });
    }
  });

  it('throws when ui-design-principles.md is missing', () => {
    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-modules-missing-'));
    try {
      fs.writeFileSync(path.join(missingDir, 'review-perspectives.md'), 'x');
      fs.writeFileSync(path.join(missingDir, 'software-design-principles.md'), 'x');
      expect(() => loadPromptModules(missingDir)).toThrow('Prompt module not found');
    } finally {
      fs.rmSync(missingDir, { recursive: true, force: true });
    }
  });

  it('uses cache on repeated calls with unchanged files', () => {
    const modules1 = loadPromptModules(tmpDir);
    const modules2 = loadPromptModules(tmpDir);
    // Both calls return identical string content
    expect(modules1.reviewPerspectives).toBe(modules2.reviewPerspectives);
    expect(modules1.softwareDesignPrinciples).toBe(modules2.softwareDesignPrinciples);
    expect(modules1.uiDesignPrinciples).toBe(modules2.uiDesignPrinciples);
  });

  it('returns updated content after file changes (mtime-based cache invalidation)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-modules-mtime-'));
    try {
      const filePath = path.join(dir, 'review-perspectives.md');
      fs.writeFileSync(path.join(dir, 'software-design-principles.md'), 'x');
      fs.writeFileSync(path.join(dir, 'ui-design-principles.md'), 'x');

      fs.writeFileSync(filePath, 'original');
      const modules1 = loadPromptModules(dir);
      expect(modules1.reviewPerspectives).toBe('original');

      // Simulate file update with different mtime
      // Wait a tick then write (mtime resolution is 1ms on most systems)
      const futureMs = Date.now() + 1000;
      fs.writeFileSync(filePath, 'updated');
      fs.utimesSync(filePath, new Date(futureMs), new Date(futureMs));

      const modules2 = loadPromptModules(dir);
      expect(modules2.reviewPerspectives).toBe('updated');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
