import { describe, it, expect } from 'vitest';
import {
  extractCommandQuery,
  filterChatCommands,
  expandCommandOutput,
  textCommandInsertion,
  type ChatCommand,
} from './chatCommands';

const MODEL_COMMAND: ChatCommand = {
  name: 'model',
  description: 'switch model',
  agentTypes: ['claude'],
  type: 'select',
  options: [
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
  ],
  output: '/model ${value}',
};

const COMPACT_COMMAND: ChatCommand = {
  name: 'compact',
  description: 'compact context',
  agentTypes: ['claude'],
  type: 'text',
};

describe('extractCommandQuery', () => {
  it('returns null when the text does not start with "/"', () => {
    expect(extractCommandQuery('hello')).toBeNull();
    expect(extractCommandQuery('')).toBeNull();
  });

  it('returns the remainder after the leading "/"', () => {
    expect(extractCommandQuery('/mo')).toBe('mo');
    expect(extractCommandQuery('/')).toBe('');
  });
});

describe('filterChatCommands', () => {
  const commands = [MODEL_COMMAND, COMPACT_COMMAND];

  it('matches by name prefix, case-insensitively', () => {
    expect(filterChatCommands(commands, 'Mo').map((c) => c.name)).toEqual(['model']);
  });

  it('matches by description prefix', () => {
    expect(filterChatCommands(commands, 'compact').map((c) => c.name)).toEqual(['compact']);
  });

  it('returns all commands for an empty query', () => {
    expect(filterChatCommands(commands, '')).toHaveLength(2);
  });

  it('returns no commands when nothing matches', () => {
    expect(filterChatCommands(commands, 'zzz')).toEqual([]);
  });
});

describe('expandCommandOutput', () => {
  it('substitutes ${value} in the output template', () => {
    expect(expandCommandOutput(MODEL_COMMAND, 'sonnet')).toBe('/model sonnet');
  });

  it('falls back to "/${name} ${value}" when output is omitted', () => {
    const command: ChatCommand = { ...MODEL_COMMAND, output: undefined };
    expect(expandCommandOutput(command, 'sonnet')).toBe('/model sonnet');
  });
});

describe('textCommandInsertion', () => {
  it('produces "/${name} "', () => {
    expect(textCommandInsertion(COMPACT_COMMAND)).toBe('/compact ');
  });
});
