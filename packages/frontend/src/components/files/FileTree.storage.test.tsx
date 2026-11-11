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
  it('keeps the default row look when no custom row is given', () => {
    const node = { name: 'dir', path: '/dir', type: 'directory' as const, expanded: true, children: [{ name: 'b.txt', path: '/dir/b.txt', type: 'file' as const, size: 2048 }] };
    render(<FileTree nodes={[node]} selectedPath="/dir/b.txt" rootPath="/" pathApi={{ separator: '/' } as never} pendingCreate={null} pendingRename={null}
      onSelect={vi.fn()} onContextMenu={vi.fn()} onLongPress={vi.fn()} onCommitCreate={vi.fn()} onCancelCreate={vi.fn()}
      onCommitRename={vi.fn()} onCancelRename={vi.fn()} getSiblingNames={() => []} longPressHandlers={() => ({ onTouchStart: vi.fn(), onTouchEnd: vi.fn(), onTouchMove: vi.fn() })} />);
    const child = screen.getByText('b.txt').parentElement as HTMLElement;
    expect(child.className).toBe('row-hover row-selected');
    expect(child.style.paddingLeft).toBe('24px');
    expect(screen.getByText('2KB')).toBeTruthy();
  });
  it('renders custom rows with their depth through expanded directories', () => {
    const renderRow = vi.fn((node: { name: string }, depth: number) => <div role="listitem">{`${node.name}@${depth}`}</div>);
    const nodes = [
      { name: 'one/', path: 'one/', type: 'directory' as const, expanded: true, children: [{ name: 'a.txt', path: 'one/a.txt', type: 'file' as const }] },
      { name: 'two/', path: 'two/', type: 'directory' as const, children: [{ name: 'hidden.txt', path: 'two/hidden.txt', type: 'file' as const }] },
    ];
    render(<FileTree nodes={nodes} renderRow={renderRow} />);
    expect(screen.getAllByRole('listitem').map((row) => row.textContent)).toEqual(['one/@0', 'a.txt@1', 'two/@0']);
  });
  it('keeps the existing breadcrumb copy control', () => {
    render(<PathBreadcrumb path="/home/project" />);
    expect(screen.getByText('project').closest('bdi')?.textContent).toBe('/›home›project');
    expect(screen.getByLabelText('/home/project')).toBeTruthy();
    expect(screen.getByTitle('rootSwitcher.copyPath')).toBeTruthy();
  });
  it('renders Windows drive and separators', () => {
    render(<PathBreadcrumb path={'C:\\Users\\project'} separator={'\\'} />);
    expect(screen.getByText('project').closest('bdi')?.textContent).toBe('C:›Users›project');
    expect(screen.getByLabelText('C:\\Users\\project')).toBeTruthy();
  });
  it('copies the unchanged Windows path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const path = 'C:\\Users\\project';
    render(<PathBreadcrumb path={path} separator={'\\'} />);
    fireEvent.click(screen.getByRole('button', { name: 'rootSwitcher.copyPath' }));
    expect(writeText).toHaveBeenCalledWith(path);
    vi.unstubAllGlobals();
  });
  it('navigates relative storage breadcrumbs', () => {
    const navigate = vi.fn();
    render(<PathBreadcrumb path="one/two/" rootLabel="Storage" onNavigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'one' }));
    expect(navigate).toHaveBeenCalledWith('one/');
  });
});
