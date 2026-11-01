import { describe, expect, it } from 'vitest';
import { buildSearchIndex, searchIndex } from './searchIndex';
import type { ProjectListItem, Task } from '../../pages/workspace/types';

const projects: ProjectListItem[] = [{ id: 1, name: 'Alpha', windows: [{ id: 806, ownerType: 'project', projectId: 1, serverName: 'host', tmuxTarget: 'a:1', label: 'Editor', labelSource: 'user', isPrimary: true, windowType: 'terminal' }] }];
const tasks: Task[] = [{ id: 371, title: 'Fix Search', status: 'running', projectId: 1, unitId: null, priority: 0, sourceRef: 'GH-42', createdAt: '', updatedAt: '' }];

describe('global search index', () => {
  const index = buildSearchIndex(projects, tasks, {}, new Set(), {});
  it('matches normalized identifiers and AND terms across fields', () => {
    expect(searchIndex(index, 'Ｗ-８０６')[0]?.title).toBe('Editor');
    expect(searchIndex(index, 'w806')[0]?.title).toBe('Editor');
    expect(searchIndex(index, '371 alpha')[0]?.title).toBe('Fix Search');
    expect(searchIndex(index, 'GH-42')[0]?.title).toBe('Fix Search');
    expect(searchIndex(index, 'editor missing')).toHaveLength(0);
  });
  it('ranks exact matches before partial matches', () => {
    expect(searchIndex(index, 'editor')[0]?.kind).toBe('window');
  });
});

describe('search ordering', () => {
  it('deduplicates windows and puts running results before idle matches', () => {
    const duplicate = projects[0].windows![0];
    const withWindow = [{ ...tasks[0], windows: [duplicate] }];
    const index = buildSearchIndex(projects, withWindow, {}, new Set([806]), {});
    expect(index.filter(item => item.kind === 'window')).toHaveLength(1);
    expect(searchIndex(index, 'alpha')[0].kind).toBe('window');
  });
  it('uses the resolved name after a rename', () => {
    const renamed = [{ ...projects[0], windows: [{ ...projects[0].windows![0], label: 'Renamed' }] }];
    const index = buildSearchIndex(renamed, tasks, {}, new Set(), {});
    expect(searchIndex(index, 'renamed')[0]?.kind).toBe('window');
    expect(searchIndex(index, 'editor')).toHaveLength(0);
  });
});

describe('window roles', () => {
  it('classifies orchestrators separately and defaults absent roles to windows', () => {
    const window = projects[0].windows![0];
    const index = buildSearchIndex([{ ...projects[0], windows: [window, { ...window, id: 807, role: 'orchestrator' }] }], tasks, {}, new Set(), {});
    expect(index.find(item => item.id === 806 && item.window)?.kind).toBe('window');
    expect(index.find(item => item.id === 807 && item.window)?.kind).toBe('orchestrator');
  });
});
