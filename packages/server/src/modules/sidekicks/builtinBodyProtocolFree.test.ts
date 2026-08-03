import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_BUILTIN_SIDEKICKS_DIR } from './SidekickPackageLoader';

/**
 * Static guard (Issue #263 Refine D): builtin Sidekick bodies (harness/sidekicks/**\/SKILL.md)
 * describe capability only. The execution protocol (completion/question/test-failure
 * signaling) is added by the execution envelope (executionEnvelope.ts), not written
 * into the body itself — otherwise it leaks into standalone render (no envelope applied).
 */
describe('builtin Sidekick bodies contain no execution-protocol tokens', () => {
  const skillFiles = fs
    .readdirSync(DEFAULT_BUILTIN_SIDEKICKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(DEFAULT_BUILTIN_SIDEKICKS_DIR, e.name, 'SKILL.md'))
    .filter((p) => fs.existsSync(p));

  it('found at least one builtin SKILL.md to check', () => {
    expect(skillFiles.length).toBeGreaterThan(0);
  });

  it.each(skillFiles)('%s has no PHASE_COMPLETE / QUESTIONS_JSON / TEST_FAILED token', (filePath) => {
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).not.toContain('PHASE_COMPLETE');
    expect(content).not.toContain('QUESTIONS_JSON');
    expect(content).not.toContain('TEST_FAILED');
  });
});
