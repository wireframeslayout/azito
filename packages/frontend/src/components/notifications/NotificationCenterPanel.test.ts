import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../utils/time', () => ({ formatRelativeTime: () => 'now' }));
import { NotificationRow } from './NotificationCenterPanel';

describe('NotificationRow', () => {
  it('renders firewall instructions in the notification', () => {
    const html = renderToStaticMarkup(createElement(NotificationRow, {
      notification: { id: '1', kind: 'server_firewall', title: 'Windows Firewall', body: 'Inspect the active rule', read: false, createdAt: Date.now() },
      onSelect: () => {},
    }));
    expect(html).toContain('Windows Firewall');
    expect(html).toContain('Inspect the active rule');
  });
});
