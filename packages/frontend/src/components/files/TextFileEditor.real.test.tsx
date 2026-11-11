// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';
import type { FilesBackend } from './backend/FilesBackend';
import { TextFileEditor } from './TextFileEditor';

vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useConfirm', () => ({ useConfirm: () => async () => true }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../hooks/useVirtualKeyboard', () => ({ useVirtualKeyboard: () => false }));
vi.mock('../../hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

describe('TextFileEditor with CodeMirror', () => {
  it('restores the editor and does not revive discarded changes on the next edit', async () => {
    const backend: FilesBackend = { source: 'real-editor', read: vi.fn(async () => ({ kind: 'text' as const, content: 'base', version: 'v1', language: 'text' })), save: vi.fn(), list: vi.fn(), create: vi.fn(), rename: vi.fn(), delete: vi.fn(), download: vi.fn() };
    const { container } = render(<TextFileEditor backend={backend} path="file" name="file" />);
    const getView = () => EditorView.findFromDOM(container.querySelector('.cm-content')!);
    await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull());
    act(() => { const view = getView()!; view.dispatch({ changes: { from: 4, insert: ' discarded' } }); });
    expect(getView()!.state.doc.toString()).toBe('base discarded');
    fireEvent.click(screen.getByRole('button', { name: 'editor.restore' }));
    await waitFor(() => expect(getView()!.state.doc.toString()).toBe('base'));
    act(() => { const view = getView()!; view.dispatch({ changes: { from: 4, insert: '!' } }); });
    expect(getView()!.state.doc.toString()).toBe('base!');
  });
});
