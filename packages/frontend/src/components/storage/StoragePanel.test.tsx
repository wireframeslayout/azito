import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StoragePanel from '../StoragePanel';

const listPage = vi.fn();
const deleteMany = vi.fn();
const stat = vi.fn();
const confirm = vi.fn();
const { uploadFile } = vi.hoisted(() => ({ uploadFile: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options?.name ? `${key} ${options.name}` : key }) }));
vi.mock('../../api/client', () => ({ uploadFile, fetchBlob: vi.fn() }));
vi.mock('../../hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../hooks/useConfirm', () => ({ useConfirm: () => confirm }));
vi.mock('../ui/BottomSheet', () => ({ BottomSheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div role="dialog">{children}</div> : null }));
vi.mock('./StorageStatusGate', () => ({ StorageStatusGate: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../files/backend/StorageFilesBackend', () => ({ StorageFilesBackend: class {
  source = 'storage:1'; listPage = listPage; deleteMany = deleteMany; stat = stat;
} }));

describe('StoragePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPage.mockResolvedValue({ entries: [{ name: 'folder', path: 'folder/', type: 'directory' }, { name: 'a.txt', path: 'a.txt', type: 'file', size: 4, lastModified: '2024-01-01' }], nextCursor: null });
    confirm.mockResolvedValue(true);
    stat.mockResolvedValue({ count: 2, totalSize: 12 });
  });
  it('navigates a folder and back to the root', async () => {
    render(<StoragePanel projectId={1} />);
    fireEvent.click(await screen.findByRole('button', { name: 'folder' }));
    await waitFor(() => expect(listPage).toHaveBeenCalledWith('folder/', null));
    fireEvent.click(screen.getByRole('button', { name: 'Storage' }));
    await waitFor(() => expect(listPage).toHaveBeenCalledWith('', null));
  });
  it('sorts size and date in both directions with missing values last', async () => {
    listPage.mockResolvedValue({ entries: [
      { name: 'small', path: 'small', type: 'file', size: 1, lastModified: '2020-01-01' },
      { name: 'large', path: 'large', type: 'file', size: 10, lastModified: '2025-01-01' },
      { name: 'unknown', path: 'unknown', type: 'file' },
    ], nextCursor: null });
    render(<StoragePanel projectId={1} />);
    await screen.findByRole('button', { name: 'small' });
    const select = screen.getByLabelText('list.sort');
    const order = () => screen.getAllByRole('button').map((button) => button.textContent).filter((name) => ['small', 'large', 'unknown'].includes(name ?? ''));
    for (const [value, expected] of [
      ['sizeAsc', ['small', 'large', 'unknown']], ['sizeDesc', ['large', 'small', 'unknown']],
      ['dateAsc', ['small', 'large', 'unknown']], ['dateDesc', ['large', 'small', 'unknown']],
    ] as const) {
      fireEvent.change(select, { target: { value } });
      expect(order()).toEqual(expected);
    }
  });
  it('checks folder statistics before confirming deletion', async () => {
    render(<StoragePanel projectId={1} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'list.select folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'list.delete' }));
    await waitFor(() => expect(stat).toHaveBeenCalledWith('folder/'));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true })));
    await waitFor(() => expect(deleteMany).toHaveBeenCalled());
  });
  it('does not delete when folder statistics fail', async () => {
    stat.mockRejectedValue(new Error('stat failed'));
    render(<StoragePanel projectId={1} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'list.select folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'list.delete' }));
    await waitFor(() => expect(stat).toHaveBeenCalled());
    expect(confirm).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });
  it('continues file uploads and displays every failure', async () => {
    uploadFile.mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('second'));
    const { container } = render(<StoragePanel projectId={1} />);
    await screen.findByRole('button', { name: 'folder' });
    const input = container.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')] } });
    await waitFor(() => expect(screen.getByText('a.txt: first')).toBeTruthy());
    expect(screen.getByText('b.txt: second')).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveStyle({ overflowY: 'auto', maxHeight: 'min(25vh, calc(var(--space-6) * 6))' });
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });
  it('keeps image upload previews in a bounded scroll area', async () => {
    const create = vi.fn().mockReturnValue('blob:preview');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    let finish!: (value: object) => void;
    uploadFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    try {
      const { container } = render(<StoragePanel projectId={1} />);
      await screen.findByRole('button', { name: 'folder' });
      fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'image.png', { type: 'image/png' })] } });
      const image = await screen.findByAltText('image.png');
      expect(image.parentElement).toHaveStyle({ overflowY: 'auto', maxHeight: 'min(25vh, calc(var(--space-6) * 6))' });
      finish({});
      await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:preview'));
    } finally { vi.unstubAllGlobals(); }
  });
  it('does not consume tab drag events', async () => {
    const { container } = render(<StoragePanel projectId={1} />);
    await screen.findByRole('button', { name: 'folder' });
    const panel = container.firstElementChild!;
    const event = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['application/x-azito-tab'] } });
    fireEvent(panel, event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('allows selecting multiple items on mobile before opening actions', async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    try {
      render(<StoragePanel projectId={1} />);
      const folder = await screen.findByRole('checkbox', { name: 'list.select folder' });
      const file = screen.getByRole('checkbox', { name: 'list.select a.txt' });
      fireEvent.click(folder);
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(file);
      expect(folder).toBeChecked();
      expect(file).toBeChecked();
      fireEvent.click(screen.getByRole('button', { name: 'list.actions' }));
      expect(screen.getByRole('dialog')).toBeTruthy();
    } finally { window.matchMedia = original; }
  });
  it('retries the failed next page even when the first page is empty', async () => {
    listPage.mockReset().mockResolvedValueOnce({ entries: [], nextCursor: 'next' }).mockRejectedValueOnce(new Error('page failed')).mockResolvedValueOnce({ entries: [], nextCursor: null });
    render(<StoragePanel projectId={1} />);
    fireEvent.click(await screen.findByRole('button', { name: 'list.loadMore' }));
    fireEvent.click(await screen.findByRole('button', { name: 'retry' }));
    await waitFor(() => expect(listPage).toHaveBeenCalledTimes(3));
    expect(listPage.mock.calls[2]).toEqual(['', 'next']);
  });

});
