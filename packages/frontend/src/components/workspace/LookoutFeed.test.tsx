import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import HomeFeed from './HomeFeed';
import { MobileStatusBar } from './MobileStatusBar';
import { buildLookoutSections } from '../../lib/lookoutSummary';
import type { Task } from '../../pages/workspace/types';

const task = { id: 1, title: 'Review task', status: 'waiting_input', projectId: 2, unitId: null, priority: 0, createdAt: '', updatedAt: '2026-01-01' } as Task;
const row = { key: 'a', title: 'Agent', serverName: 'local', target: 'a', status: 'running' as const, taskId: 1 };
let sections = buildLookoutSections({ rows: [row], allTasks: [task], lastSeenMs: 0 });
const selectTerminal = vi.hoisted(() => vi.fn());
vi.mock('./TaskPanel', () => ({ selectTaskTerminal: selectTerminal }));
vi.mock('./ServerHealthSheet', () => ({ ServerHealthSheet: () => null }));
vi.mock('../../hooks/useLookout', () => ({ useLookout: () => ({ sections, rows: [row], historyCount: 0 }) }));
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string, options?: { count?: number }) => key === 'workspace:activityPill.statusBarWorking' ? `${key}:${options?.count}` : key }) }));
vi.mock('../../hooks/useActiveWindowRows', () => ({ useActiveWindowRows: () => ({ rows: [row], historyCount: 0 }) }));
vi.mock('../../hooks/useAgentActivity', () => ({ useAgentActivity: () => ({ markFinishedSeen: vi.fn(), dismissFinished: vi.fn(), clearSeenFinished: vi.fn(), retention: { maxCount: 10 } }) }));
vi.mock('../../hooks/useServerResources', () => ({ useServerResourcesContext: () => [], getWorstHealth: () => 'unknown', getHealthLevel: () => 'unknown' }));
vi.mock('../../hooks/useTerminalTargetOpener', () => ({ useOpenTerminalTarget: () => vi.fn() }));

const props = { openTask: vi.fn(), connectPane: vi.fn() };

describe('Lookout workspace feeds', () => {
  it('shows an attention task once in HomeFeed and opens it', () => {
    render(<HomeFeed {...props} allProjects={[]} onAddWindow={vi.fn()} />);
    expect(screen.getAllByText('Review task')).toHaveLength(1);
    fireEvent.click(screen.getByText('Review task'));
    expect(props.openTask).toHaveBeenCalledWith(1, 'Review task', 2);
  });
  it('selects the blocked task window when opened', () => {
    sections = buildLookoutSections({ rows: [{ ...row, activityStatus: 'blocked' }], allTasks: [task], lastSeenMs: 0 });
    render(<HomeFeed {...props} allProjects={[]} onAddWindow={vi.fn()} />);
    fireEvent.click(screen.getByText('Review task'));
    expect(selectTerminal).toHaveBeenCalledWith(1, { serverName: 'local', target: 'a' });
    sections = buildLookoutSections({ rows: [row], allTasks: [task], lastSeenMs: 0 });
  });
  it('shows the revised attention and active section counts', () => {
    const failed = { ...task, id: 2, title: 'Failed', status: 'failed' };
    const review = { ...task, id: 3, title: 'Phase review', status: 'phase_review' };
    sections = buildLookoutSections({ rows: [row, { ...row, key: 'blocked', title: 'Blocked', target: 'blocked', taskId: undefined, activityStatus: 'blocked' }, { ...row, key: 'working', title: 'Working', target: 'working', taskId: undefined }], allTasks: [task, failed, review], lastSeenMs: 0 });
    render(<HomeFeed {...props} allProjects={[]} onAddWindow={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /sections.attention 4/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /sections.active 1/ })).toBeTruthy();
    sections = buildLookoutSections({ rows: [row], allTasks: [task], lastSeenMs: 0 });
  });
  it('does not count a task without a running window as working or show the empty state', () => {
    sections = buildLookoutSections({ rows: [], allTasks: [task], lastSeenMs: 0 });
    render(<MobileStatusBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'workspace:activityPill.ariaLabel' }));
    expect(screen.getByText('Review task')).toBeTruthy();
    expect(screen.getByText('workspace:activityPill.statusBarWorking:0')).toBeTruthy();
    expect(screen.queryByText('workspace:activityPill.empty')).toBeNull();
    sections = buildLookoutSections({ rows: [row], allTasks: [task], lastSeenMs: 0 });
  });
  it('shows the same attention task once in the mobile panel and opens it', () => {
    render(<MobileStatusBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'workspace:activityPill.ariaLabel' }));
    expect(screen.getAllByText('Review task')).toHaveLength(1);
    fireEvent.click(screen.getByText('Review task'));
    expect(props.openTask).toHaveBeenCalledWith(1, 'Review task', 2);
  });
});
