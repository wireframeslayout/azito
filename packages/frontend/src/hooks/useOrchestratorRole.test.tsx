// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from './useToast';
import { useOrchestratorRole } from './useOrchestratorRole';

const mocks = vi.hoisted(() => ({ apiWithStatus: vi.fn(), refresh: vi.fn() }));
vi.mock('../api/client', () => ({ apiWithStatus: mocks.apiWithStatus }));
vi.mock('./useOrchestrators', () => ({ useOrchestrators: () => ({ refresh: mocks.refresh, windows: [], status: 'ready' }) }));
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));

function Probe({ windowId }: { windowId: number }) {
  const changeRole = useOrchestratorRole();
  const { pathname } = useLocation();
  return <><span data-testid="path">{pathname}</span><button onClick={() => { void changeRole(windowId, null); }}>remove</button></>;
}

function renderAt(path: string, windowId: number) {
  return render(<ToastProvider><MemoryRouter initialEntries={[path]}><Routes><Route path="*" element={<Probe windowId={windowId} />} /></Routes></MemoryRouter></ToastProvider>);
}

describe('useOrchestratorRole', () => {
  beforeEach(() => { mocks.apiWithStatus.mockReset(); mocks.refresh.mockReset(); });

  it('leaves the page of the orchestrator whose role is cleared and keeps the undo toast', async () => {
    mocks.apiWithStatus.mockResolvedValue({ status: 200, body: { ok: true } });
    renderAt('/orchestration/5', 5);
    await userEvent.click(screen.getByRole('button', { name: 'remove' }));
    expect(await screen.findByText('orchestration.restored')).toBeVisible();
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/orchestration$/);
    await userEvent.click(screen.getByRole('button', { name: 'orchestration.undo' }));
    expect(mocks.apiWithStatus).toHaveBeenLastCalledWith('/windows/5/role', expect.objectContaining({ body: JSON.stringify({ role: 'orchestrator' }) }));
  });

  it('stays on another page and reports a failed change', async () => {
    mocks.apiWithStatus.mockResolvedValue({ status: 409, body: { error: 'conflict' } });
    renderAt('/orchestration/7', 5);
    await userEvent.click(screen.getByRole('button', { name: 'remove' }));
    expect(await screen.findByText('orchestration.roleError')).toBeVisible();
    expect(screen.getByTestId('path')).toHaveTextContent('/orchestration/7');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('keeps an action toast for longer than a plain one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.apiWithStatus.mockResolvedValue({ status: 200, body: { ok: true } });
      renderAt('/workspace/1', 5);
      await act(async () => { screen.getByRole('button', { name: 'remove' }).click(); });
      act(() => { vi.advanceTimersByTime(5000); });
      expect(screen.getByRole('button', { name: 'orchestration.undo' })).toBeVisible();
      act(() => { vi.advanceTimersByTime(6000); });
      expect(screen.queryByRole('button', { name: 'orchestration.undo' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
