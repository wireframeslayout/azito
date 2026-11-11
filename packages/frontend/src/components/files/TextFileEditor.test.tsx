// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FilesBackend } from './backend/FilesBackend';
import { TextFileEditor } from './TextFileEditor';

vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../ui/Overlay', () => ({ Overlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('../../hooks/useConfirm', () => ({ useConfirm: () => async () => true }));
vi.mock('../../hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => mobile.value }));
vi.mock('../../hooks/useVirtualKeyboard', () => ({ useVirtualKeyboard: () => false }));
vi.mock('../editor/CodeEditorView', () => ({ default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="editor" value={value} onChange={(event) => onChange(event.target.value)} /> }));
vi.mock('../editor/EditorStatusBar', () => ({ default: () => null }));

describe('TextFileEditor', () => {
  it('restores edited content after confirmation and shows metadata', async () => {
    const backend: FilesBackend = { source: 'restore', read: vi.fn(async () => ({ kind: 'text' as const, content: 'base', version: 'v1', language: 'text' })), save: vi.fn(), list: vi.fn(), create: vi.fn(), rename: vi.fn(), delete: vi.fn(), download: vi.fn() };
    render(<TextFileEditor backend={backend} path="file" name="file" />);
    const editor = await screen.findByRole('textbox', { name: 'editor' });
    const restore = screen.getByRole('button', { name: 'editor.restore' }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    expect(screen.getByText('UTF-8')).toBeTruthy();
    fireEvent.change(editor, { target: { value: 'one\ntwo\n' } });
    expect(restore.disabled).toBe(false);
    fireEvent.click(restore);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe('base'));
    expect(restore.disabled).toBe(true);
  });
  it('retains local text and presents a comparison when saving conflicts', async () => {
    const backend: FilesBackend = {
      source: 'test',
      read: vi.fn(async () => ({ kind: 'text' as const, content: 'base', version: 'v1', language: 'text' })),
      save: vi.fn(async () => ({ kind: 'conflict' as const, latest: { kind: 'text' as const, content: 'remote', version: 'v2', language: 'text' } })),
      list: vi.fn(), create: vi.fn(), rename: vi.fn(), delete: vi.fn(), download: vi.fn(),
    };
    render(<TextFileEditor backend={backend} path="file" name="file" />);
    const editor = await screen.findByRole('textbox', { name: 'editor' });
    fireEvent.change(editor, { target: { value: 'local' } });
    fireEvent.click(screen.getByRole('button', { name: 'editor.save' }));
    await waitFor(() => expect(screen.getAllByRole('status').some((element) => element.getAttribute('aria-live') === 'polite' && element.textContent === 'editor.conflict')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'editor.diff' }));
    expect(screen.getByText('- remote')).toBeTruthy();
    expect(screen.getByText('+ local')).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe('local');
  });
  it('ignores Ctrl+S while the file is unchanged or a conflict is unresolved', async () => {
    const backend: FilesBackend = {
      source: 'test',
      read: vi.fn(async () => ({ kind: 'text' as const, content: 'base', version: 'v1', language: 'text' })),
      save: vi.fn(async () => ({ kind: 'conflict' as const, latest: null })),
      list: vi.fn(), create: vi.fn(), rename: vi.fn(), delete: vi.fn(), download: vi.fn(),
    };
    render(<TextFileEditor backend={backend} path="file" name="file" />);
    const editor = await screen.findByRole('textbox', { name: 'editor' });
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    expect(backend.save).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: 'local' } });
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    await waitFor(() => expect(screen.getByText('editor.latestUnavailable')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    expect(backend.save).toHaveBeenCalledTimes(1);
  });
  it('explains an oversized file in the UI language and offers its download', async () => {
    const download = vi.fn(async () => new Blob(['x']));
    const backend: FilesBackend = {
      source: 'test',
      read: vi.fn(async () => ({ kind: 'unavailable' as const, code: 'too_large' as const, message: 'File exceeds 500 KiB' })),
      save: vi.fn(), list: vi.fn(), create: vi.fn(), rename: vi.fn(), delete: vi.fn(), download,
    };
    const downloadAction = <button>download</button>;
    render(<TextFileEditor backend={backend} path="file" name="file" downloadAction={downloadAction} headerActions={<>{downloadAction}<button>VS Code</button><button>Zed</button></>} />);
    const notice = (await screen.findByText('editor.unavailable.too_large')).closest('[role="status"]');
    expect(notice).not.toBeNull();
    expect(within(notice as HTMLElement).getByRole('button', { name: 'download' })).toBeTruthy();
    expect(within(notice as HTMLElement).queryByRole('button', { name: 'VS Code' })).toBeNull();
    expect(within(notice as HTMLElement).queryByRole('button', { name: 'Zed' })).toBeNull();
    expect(screen.queryByText('File exceeds 500 KiB')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'editor' })).toBeNull();
  });
  it('hides split mode on mobile', async () => {
    mobile.value = true;
    localStorage.setItem('azito-md-view-mode', 'split');
    const backend: FilesBackend = { source: 'mobile', read: vi.fn(async () => ({ kind: 'text' as const, content: 'md', version: 'v', language: 'markdown' })), save: vi.fn(), list: vi.fn(), create: vi.fn(), rename: vi.fn(), delete: vi.fn(), download: vi.fn() };
    render(<TextFileEditor backend={backend} path="a.md" name="a.md" />);
    await screen.findByRole('textbox', { name: 'editor' });
    expect(screen.queryByText('explorer.splitView')).toBeNull();
    mobile.value = false;
  });

  it('saves from the focused Markdown preview', async () => {
    localStorage.setItem('azito-md-view-mode', 'source');
    const backend: FilesBackend = { source: 'preview', read: vi.fn(async () => ({ kind: 'text' as const, content: 'base', version: 'v', language: 'markdown' })), save: vi.fn(async () => ({ kind: 'saved' as const, version: 'v2' })), list: vi.fn(), create: vi.fn(), rename: vi.fn(), delete: vi.fn(), download: vi.fn() };
    render(<TextFileEditor backend={backend} path="a.md" name="a.md" />);
    const editor = await screen.findByRole('textbox', { name: 'editor' });
    fireEvent.change(editor, { target: { value: 'edited' } });
    fireEvent.click(screen.getByRole('tab', { name: 'explorer.previewView' }));
    const preview = screen.getByText('edited').closest('[tabindex="0"]');
    expect(preview).not.toBeNull();
    fireEvent.keyDown(preview!, { key: 's', metaKey: true });
    await waitFor(() => expect(backend.save).toHaveBeenCalledTimes(1));
  });

});
