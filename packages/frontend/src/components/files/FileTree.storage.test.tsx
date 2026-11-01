import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FileTree from './FileTree';
import { PathBreadcrumb } from './PathBreadcrumb';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

describe('shared file navigation', () => {
  it('keeps the default file tree row and selection behavior', () => {
    const onSelect = vi.fn();
    const node = { name: 'a.txt', path: '/a.txt', type: 'file' as const };
    render(<FileTree nodes={[node]} selectedPath={null} rootPath="/" pathApi={{ separator: '/' } as never} pendingCreate={null} pendingRename={null}
      onSelect={onSelect} onContextMenu={vi.fn()} onLongPress={vi.fn()} onCommitCreate={vi.fn()} onCancelCreate={vi.fn()}
      onCommitRename={vi.fn()} onCancelRename={vi.fn()} getSiblingNames={() => []} longPressHandlers={() => ({ onTouchStart: vi.fn(), onTouchEnd: vi.fn(), onTouchMove: vi.fn() })} />);
    fireEvent.click(screen.getByText('a.txt'));
    expect(onSelect).toHaveBeenCalledWith(node);
  });
  it('keeps the existing breadcrumb copy control', () => {
    render(<PathBreadcrumb path="/home/project" />);
    expect(screen.getByText('/home/project')).toBeTruthy();
    expect(screen.getByTitle('rootSwitcher.copyPath')).toBeTruthy();
  });
  it('navigates relative storage breadcrumbs', () => {
    const navigate = vi.fn();
    render(<PathBreadcrumb path="one/two/" rootLabel="Storage" onNavigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'one' }));
    expect(navigate).toHaveBeenCalledWith('one/');
  });
});
