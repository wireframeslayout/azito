import { test, expect } from '../fixtures/test';

test('キーボード設定が再読込後も維持される', async ({ app, harness }) => {
  await app.goto(`${harness.baseUrl}/settings/keyboard`);
  const search = app.getByRole('tablist', { name: '検索を開くキー' });
  const interval = app.getByRole('tablist', { name: '2 回押しの間隔' });
  const maximize = app.getByRole('tablist', { name: '拡大を開くキー' });
  await search.getByRole('tab', { name: 'Ctrl+K' }).click();
  await interval.getByRole('tab', { name: '0.5 秒' }).click();
  await maximize.getByRole('tab', { name: '使わない' }).click();
  expect(await app.evaluate(() => localStorage.getItem('azito-hotkeys'))).not.toBeNull();
  expect(await app.evaluate(() => localStorage.getItem('azito-hotkeys-chord-ms'))).toBe('500');
  await app.reload();
  await expect(search.getByRole('tab', { name: 'Ctrl+K' })).toHaveAttribute('aria-selected', 'true');
  await expect(interval.getByRole('tab', { name: '0.5 秒' })).toHaveAttribute('aria-selected', 'true');
  await expect(maximize.getByRole('tab', { name: '使わない' })).toHaveAttribute('aria-selected', 'true');
});
