import { createLucideIcon } from 'lucide-react';

// Icon.tsx 専用のカスタム Lucide 風アイコン。
// 旧 pixel-icons のモチーフ（アンテナ+頭+ボディのロボット）を Lucide のストローク文法に翻訳したもの。
// createLucideIcon の戻り値型は LucideIcon そのものなので、Icon.tsx の
// `satisfies Record<string, LucideIcon>` にキャスト無しで適合する。

// 相棒ロボット（旧 pixel 'sidekicks' のモチーフ: アンテナ+頭(目2)+ボディ(コア)+両腕）
export const SidekickBot = createLucideIcon('sidekick-bot', [
  ['circle', { cx: '12', cy: '3.25', r: '1.25', key: 'sidekick-antenna-tip' }],
  ['path', { d: 'M12 4.5V7', key: 'sidekick-antenna-stem' }],
  ['rect', { x: '6.5', y: '7', width: '11', height: '7.5', rx: '2', key: 'sidekick-head' }],
  ['path', { d: 'M10 10.25v1.5', key: 'sidekick-eye-left' }],
  ['path', { d: 'M14 10.25v1.5', key: 'sidekick-eye-right' }],
  ['rect', { x: '8.75', y: '16.5', width: '6.5', height: '4.5', rx: '1.5', key: 'sidekick-body' }],
  ['path', { d: 'M12 18.75h.01', key: 'sidekick-core' }],
  ['path', { d: 'M5.25 17v3', key: 'sidekick-arm-left' }],
  ['path', { d: 'M18.75 17v3', key: 'sidekick-arm-right' }],
]);

// スクワッド（旧 pixel 'units': リーダー機の背後に2機の頭部が覗く）
export const UnitsSquad = createLucideIcon('units-squad', [
  ['path', { d: 'M8.5 4.75H5.5a2 2 0 0 0-2 2v3.5a2 2 0 0 0 2 2h.75', key: 'units-head-back-left' }],
  ['path', { d: 'M5.75 8.25h.01', key: 'units-eye-back-left' }],
  ['path', { d: 'M15.5 4.75h3a2 2 0 0 1 2 2v3.5a2 2 0 0 1-2 2h-.75', key: 'units-head-back-right' }],
  ['path', { d: 'M18.25 8.25h.01', key: 'units-eye-back-right' }],
  ['circle', { cx: '12', cy: '4', r: '1', key: 'units-antenna-tip' }],
  ['path', { d: 'M12 5v1.5', key: 'units-antenna-stem' }],
  ['rect', { x: '7', y: '6.5', width: '10', height: '7', rx: '2', key: 'units-head-leader' }],
  ['path', { d: 'M10 9.5v1.4', key: 'units-eye-left' }],
  ['path', { d: 'M14 9.5v1.4', key: 'units-eye-right' }],
  ['rect', { x: '9', y: '15.5', width: '6', height: '4', rx: '1.5', key: 'units-body' }],
  ['path', { d: 'M12 17.5h.01', key: 'units-core' }],
  ['path', { d: 'M6.25 16v2.5', key: 'units-arm-left' }],
  ['path', { d: 'M17.75 16v2.5', key: 'units-arm-right' }],
]);
