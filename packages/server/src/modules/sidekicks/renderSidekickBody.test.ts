import { describe, it, expect } from 'vitest';
import { renderSidekickBody } from './renderSidekickBody';

describe('renderSidekickBody', () => {
  it('expands {{sidekick.dir}} and {{sidekick.name}} from the package itself', () => {
    const pkg = { dir: '/abs/path/to/pushing-default', name: 'pushing-default', body: 'run {{sidekick.dir}}/scripts/push.sh ({{sidekick.name}})' };
    const result = renderSidekickBody(pkg, {});
    expect(result).toBe('run /abs/path/to/pushing-default/scripts/push.sh (pushing-default)');
  });

  it('also expands variables passed in via vars (e.g. {{task.*}})', () => {
    const pkg = { dir: '/x', name: 'planning-default', body: 'Title: {{task.title}}\nDir: {{sidekick.dir}}' };
    const result = renderSidekickBody(pkg, { task: { title: 'My Task' } });
    expect(result).toBe('Title: My Task\nDir: /x');
  });

  it('does not template-expand script file contents (the body is the only thing rendered)', () => {
    // renderSidekickBody only ever receives pkg.body (SKILL.md), never scripts/*.sh contents.
    // This test documents that a script's own {{...}} placeholders (if any) are untouched
    // because the function has no path to a script's content at all.
    const pkg = { dir: '/x', name: 'pushing-default', body: 'See {{sidekick.dir}}/scripts/push.sh for the {{task.title}} placeholder contract' };
    const scriptContent = 'echo "{{task.title}}"'; // hypothetical script content, never passed to the renderer
    const result = renderSidekickBody(pkg, { task: { title: 'ignored-injection' } });
    expect(result).not.toContain(scriptContent.replace('{{task.title}}', 'ignored-injection'));
    expect(result).toContain('for the ignored-injection placeholder contract');
  });

  it('leaves unknown variables as empty string (expandPromptTemplate default behavior)', () => {
    const pkg = { dir: '/x', name: 'n', body: '{{project.unknownVar}}' };
    expect(renderSidekickBody(pkg, {})).toBe('');
  });

  it('uses dirOverride for {{sidekick.dir}} when provided (Issue #263 Phase 6: remote execution)', () => {
    const pkg = { dir: '/harness/sidekicks/pushing-default', name: 'pushing-default', body: 'run {{sidekick.dir}}/scripts/push.sh' };
    const result = renderSidekickBody(pkg, {}, false, '~/.azito/sidekicks/pushing-default');
    expect(result).toBe('run ~/.azito/sidekicks/pushing-default/scripts/push.sh');
  });

  it('falls back to pkg.dir when dirOverride is omitted', () => {
    const pkg = { dir: '/harness/sidekicks/pushing-default', name: 'pushing-default', body: '{{sidekick.dir}}' };
    expect(renderSidekickBody(pkg, {})).toBe('/harness/sidekicks/pushing-default');
  });
});
