import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import PromptInputBar from './PromptInputBar';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ apiWithStatus: api }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./useChatCommands', () => ({ useChatCommands: () => [] }));

beforeEach(() => { localStorage.clear(); api.mockReset(); });
it('keeps an unsuccessful relay draft and confirms only a successful request to the parent', async () => {
  api.mockResolvedValueOnce({ status: 409, body: { error: 'busy' } }).mockResolvedValueOnce({ status: 200, body: { ok: true } });
  render(<PromptInputBar windowId={1} paneId="%1" draftKey="parent.child" agentDetected contextHistory={[]} onSent={() => {}} relay={{ sessionId: 'parent', agentId: 'child', name: 'worker', status: 'unknown' }} />);
  expect(screen.getByText(/subagents.unknownNotice/)).toBeTruthy();
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'promptBar.sendWithShortcut' }));
  await screen.findByText('subagents.errors.busy');
  expect(input).toHaveValue('hello');
  fireEvent.click(screen.getByRole('button', { name: 'promptBar.sendWithShortcut' }));
  await screen.findByText('subagents.relaySent');
  await waitFor(() => expect(input).toHaveValue(''));
});

 it('shows the reason without relay input when unavailable', () => {
  render(<PromptInputBar windowId={1} paneId="%1" draftKey="parent.child" agentDetected contextHistory={[]} onSent={() => {}} readOnlyReason="No routing name" />);
  expect(screen.getByRole('note')).toHaveTextContent('No routing name');
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'promptBar.sendWithShortcut' })).not.toBeInTheDocument();
});
