import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from './frontmatterParser';

describe('parseFrontmatter', () => {
  it('parses a normal frontmatter block', () => {
    const raw = `---
name: pushing-default
description: commit/push/PR作成を行う
phase: pushing
isDefault: true
---
body line 1
body line 2`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({
      name: 'pushing-default',
      description: 'commit/push/PR作成を行う',
      phase: 'pushing',
      isDefault: 'true',
    });
    expect(body).toBe('body line 1\nbody line 2');
  });

  it('handles values wrapped in double quotes', () => {
    const raw = `---
name: foo
description: "a quoted value"
---
body`;
    expect(parseFrontmatter(raw).frontmatter.description).toBe('a quoted value');
  });

  it('handles values wrapped in single quotes', () => {
    const raw = `---
name: foo
description: 'a quoted value'
---
body`;
    expect(parseFrontmatter(raw).frontmatter.description).toBe('a quoted value');
  });

  it('keeps colons inside the value intact (splits only on the first colon)', () => {
    const raw = `---
name: foo
description: push: commit and open a PR
---
body`;
    expect(parseFrontmatter(raw).frontmatter.description).toBe('push: commit and open a PR');
  });

  it('skips blank lines inside the frontmatter block', () => {
    const raw = `---
name: foo

description: bar
---
body`;
    expect(parseFrontmatter(raw).frontmatter).toEqual({ name: 'foo', description: 'bar' });
  });

  it('throws when the file does not start with "---"', () => {
    expect(() => parseFrontmatter('name: foo\n---\nbody')).toThrow('must start with a "---"');
  });

  it('throws when the frontmatter block is not terminated', () => {
    expect(() => parseFrontmatter('---\nname: foo\nbody')).toThrow('not terminated');
  });

  it('throws on a frontmatter line without a colon', () => {
    expect(() => parseFrontmatter('---\nnotakeyvalue\n---\nbody')).toThrow('missing ":"');
  });

  it('returns empty body when there is no content after the closing "---"', () => {
    const { body } = parseFrontmatter('---\nname: foo\n---\n');
    expect(body).toBe('');
  });
});
