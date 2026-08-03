import { describe, it, expect } from 'vitest';
import { expandPromptTemplate } from './promptTemplate';

describe('expandPromptTemplate', () => {
  it('replaces known variables', () => {
    const result = expandPromptTemplate('Hello {{task.title}}!', {
      task: { title: 'My Task' },
    });
    expect(result).toBe('Hello My Task!');
  });

  it('replaces multiple variables', () => {
    const result = expandPromptTemplate('{{task.title}} in {{project.defaultBranch}}', {
      task: { title: 'feat' },
      project: { defaultBranch: 'main' },
    });
    expect(result).toBe('feat in main');
  });

  it('replaces unknown variable with empty string by default', () => {
    const result = expandPromptTemplate('{{task.unknown}}', { task: {} });
    expect(result).toBe('');
  });

  it('keeps unknown variable when keepUnknown=true', () => {
    const result = expandPromptTemplate('{{task.unknown}}', { task: {} }, true);
    expect(result).toBe('{{task.unknown}}');
  });

  it('keeps unknown group when keepUnknown=true', () => {
    const result = expandPromptTemplate('{{other.key}}', {}, true);
    expect(result).toBe('{{other.key}}');
  });

  it('returns template unchanged when no variables', () => {
    const result = expandPromptTemplate('plain text', {});
    expect(result).toBe('plain text');
  });
});
