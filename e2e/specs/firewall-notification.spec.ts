import { test, expect } from '../fixtures/test';
import type { WebSocketRoute } from '@playwright/test';

test('randomUUID がない環境でもファイアウォール通知を表示して保存する', async ({ app, harness }) => {
  await app.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    localStorage.removeItem('azito-notifications');
  });

  let eventsSocket: WebSocketRoute | undefined;
  await app.routeWebSocket(/\/ws\?.*mode=events/, (socket) => { eventsSocket = socket; });
  await app.goto(harness.baseUrl);
  await expect(app.getByRole('button', { name: '通知', exact: true })).toBeVisible();
  await expect.poll(() => eventsSocket !== undefined).toBe(true);
  eventsSocket!.send(JSON.stringify({
    type: 'server:firewall',
    payload: {
      serverName: 'test-server',
      diagnosis: { state: 'blocked', blockedBy: ['test-rule'], commands: ['inspect firewall'], checkedAt: Date.now(), networkCategory: null },
    },
  }));

  const bell = app.getByRole('button', { name: '通知（1件未読）' });
  await expect(bell).toBeVisible();
  await bell.click();
  const row = app.locator('.notification-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('test-server');
  await expect(row).toContainText('test-rule');
  await expect(row).toContainText('inspect firewall');
  await expect.poll(() => app.evaluate(() => JSON.parse(localStorage.getItem('azito-notifications') || '[]'))).toMatchObject([
    { kind: 'server_firewall', serverName: 'test-server', read: false },
  ]);
});
