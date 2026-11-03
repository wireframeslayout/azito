import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { LookoutProvider, useLookout } from './useLookout';

vi.mock('./useWorkspaceCatalog', () => ({ useWorkspaceCatalog: () => ({ allProjects: [], allTasks: [] }) }));
const data = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('./useActiveWindowRows', () => ({ useActiveWindowRows: () => data }));
function View() {
  const value = useLookout();
  return <><output>{value.sections.counts.finished}</output><button onClick={value.openDrawer}>open</button><button onClick={value.closeDrawer}>close</button></>;
}
beforeEach(() => { localStorage.clear(); data.rows = []; });
it('keeps the previous boundary while open and saves the opening time on close', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  data.rows = [{ key: 'one', title: 'one', serverName: 'local', target: 's:1', status: 'finished', finishedAt: 500 }];
  render(<LookoutProvider><View /></LookoutProvider>);
  expect(screen.getByRole('status')).toHaveTextContent('1');
  fireEvent.click(screen.getByText('open'));
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'azito-lookout-last-seen', newValue: '900' })));
  expect(screen.getByRole('status')).toHaveTextContent('1');
  fireEvent.click(screen.getByText('close'));
  expect(localStorage.getItem('azito-lookout-last-seen')).toBe('1000');
  expect(screen.getByRole('status')).toHaveTextContent('0');
  vi.restoreAllMocks();
});
