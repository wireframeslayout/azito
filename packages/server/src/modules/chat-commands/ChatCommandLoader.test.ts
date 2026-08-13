import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChatCommandLoader } from './ChatCommandLoader';

function writeFile(filePath: string, content: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(content));
}

describe('ChatCommandLoader', () => {
  let dir: string;
  let builtinPath: string;
  let userPath: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-commands-'));
    builtinPath = path.join(dir, 'builtin.json');
    userPath = path.join(dir, 'user.json');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  it('lists builtin commands when the user layer is missing', () => {
    writeFile(builtinPath, {
      commands: [
        { name: 'model', description: 'switch model', agentTypes: ['claude'], type: 'select', options: [{ value: 'sonnet', label: 'Sonnet' }] },
      ],
    });
    const loader = new ChatCommandLoader(builtinPath, userPath);
    const list = loader.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('model');
  });

  it('merges layers with the user layer winning on same name', () => {
    writeFile(builtinPath, {
      commands: [
        { name: 'model', description: 'builtin desc', agentTypes: ['claude'], type: 'select', options: [{ value: 'sonnet', label: 'Sonnet' }] },
        { name: 'compact', description: 'compact', agentTypes: ['claude'], type: 'text' },
      ],
    });
    writeFile(userPath, {
      commands: [
        { name: 'model', description: 'user override', agentTypes: ['claude'], type: 'select', options: [{ value: 'opus', label: 'Opus' }] },
      ],
    });
    const loader = new ChatCommandLoader(builtinPath, userPath);
    const list = loader.list();
    expect(list).toHaveLength(2);
    const model = list.find((c) => c.name === 'model');
    expect(model?.description).toBe('user override');
  });

  it('filters commands by agentTypes', () => {
    writeFile(builtinPath, {
      commands: [
        { name: 'model', description: 'switch model', agentTypes: ['claude'], type: 'select', options: [{ value: 'sonnet', label: 'Sonnet' }] },
        { name: 'other', description: 'codex only', agentTypes: ['codex'], type: 'text' },
      ],
    });
    const loader = new ChatCommandLoader(builtinPath, userPath);
    expect(loader.listForAgentType('claude').map((c) => c.name)).toEqual(['model']);
    expect(loader.listForAgentType('codex').map((c) => c.name)).toEqual(['other']);
  });

  it('skips an invalid entry but keeps valid ones, logging a warning', () => {
    writeFile(builtinPath, {
      commands: [
        { name: 'model', description: 'switch model', agentTypes: ['claude'], type: 'select', options: [{ value: 'sonnet', label: 'Sonnet' }] },
        { name: 'Bad Name!', description: 'invalid name', agentTypes: ['claude'], type: 'text' },
        { name: 'broken-select', description: 'no options', agentTypes: ['claude'], type: 'select' },
      ],
    });
    const loader = new ChatCommandLoader(builtinPath, userPath);
    const list = loader.list();
    expect(list.map((c) => c.name)).toEqual(['model']);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('skips a malformed file (not JSON) without throwing, logging a warning', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(builtinPath, '{ not valid json');
    const loader = new ChatCommandLoader(builtinPath, userPath);
    expect(loader.list()).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('treats a missing file as an empty layer (no throw)', () => {
    const loader = new ChatCommandLoader(builtinPath, userPath);
    expect(loader.list()).toEqual([]);
  });

  it('fills in the default output template when omitted', () => {
    writeFile(builtinPath, {
      commands: [
        { name: 'model', description: 'switch model', agentTypes: ['claude'], type: 'select', options: [{ value: 'sonnet', label: 'Sonnet' }] },
      ],
    });
    const loader = new ChatCommandLoader(builtinPath, userPath);
    expect(loader.list()[0].output).toBe('/model ${value}');
  });

  it('keeps an explicit output template as-is', () => {
    writeFile(builtinPath, {
      commands: [
        { name: 'model', description: 'switch model', agentTypes: ['claude'], type: 'select', output: '/model ${value} extra', options: [{ value: 'sonnet', label: 'Sonnet' }] },
      ],
    });
    const loader = new ChatCommandLoader(builtinPath, userPath);
    expect(loader.list()[0].output).toBe('/model ${value} extra');
  });

  it('re-reads a file after invalidateCache when mtime is unchanged within the same tick', () => {
    writeFile(builtinPath, { commands: [{ name: 'model', description: 'a', agentTypes: ['claude'], type: 'text' }] });
    const loader = new ChatCommandLoader(builtinPath, userPath);
    expect(loader.list()[0].description).toBe('a');
    writeFile(builtinPath, { commands: [{ name: 'model', description: 'b', agentTypes: ['claude'], type: 'text' }] });
    loader.invalidateCache();
    expect(loader.list()[0].description).toBe('b');
  });
});
