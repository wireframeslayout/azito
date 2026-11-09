import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LookoutSettings } from './LookoutSettings';
import { LOOKOUT_NOTIFY_INTERVAL_KEY, writeLookoutNotifyInterval } from '../../../lib/lookoutNotifyInterval';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../../api/client', () => ({ apiWithStatus: request }));
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));

describe('LookoutSettings', () => {
  it('shares notification interval changes with the same and other tabs', async () => {
    localStorage.clear();
    request.mockResolvedValue({ status: 200, body: [] });
    render(<LookoutSettings />);
    fireEvent.click(screen.getByRole('tab', { name: 'lookout.interval15min' }));
    expect(localStorage.getItem(LOOKOUT_NOTIFY_INTERVAL_KEY)).toBe('15min');
    act(() => writeLookoutNotifyInterval('off'));
    expect(screen.getByRole('tab', { name: 'lookout.intervalOff' }).getAttribute('aria-selected')).toBe('true');
    localStorage.setItem(LOOKOUT_NOTIFY_INTERVAL_KEY, 'immediate');
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: LOOKOUT_NOTIFY_INTERVAL_KEY })));
    expect(screen.getByRole('tab', { name: 'lookout.intervalImmediate' }).getAttribute('aria-selected')).toBe('true');
    localStorage.clear();
  });
  it('saves settings and reports a failed save', async () => {
    request.mockImplementation(async (path: string, options?: RequestInit) => {
      if (options?.method === 'PUT') return { status: 500, body: {} };
      if (path === '/settings/lookout') return { status: 200, body: { enabled: false, provider: 'claude', model: 'haiku', updatedAt: '' } };
      return { status: 200, body: [{ id: 'haiku', label: 'Haiku' }] };
    });
    render(<LookoutSettings />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'lookout.save' }));
    await waitFor(() => expect(screen.getByText('lookout.saveFailed')).toBeTruthy());
    expect(request).toHaveBeenCalledWith('/settings/lookout', expect.objectContaining({ method: 'PUT' }));
  });
});
