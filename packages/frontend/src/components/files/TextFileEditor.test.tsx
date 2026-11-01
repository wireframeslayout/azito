// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FilesBackend } from './backend/FilesBackend';
import { TextFileEditor } from './TextFileEditor';

vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../ui/Overlay', () => ({ Overlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('../../hooks/useConfirm', () => ({ useConfirm: () => async () => true }));
vi.mock('../../hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../hooks/useVirtualKeyboard', () => ({ useVirtualKeyboard: () => false }));
vi.mock('../editor/CodeEditorView', () => ({ default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="editor" value={value} onChange={(event) => onChange(event.target.value)} /> }));
vi.mock('../editor/EditorStatusBar', () => ({ default: () => null }));

describe('TextFileEditor', () => {
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
    await waitFor(() => expect(screen.getByText(/editor.conflict/)).toBeTruthy());
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
});
