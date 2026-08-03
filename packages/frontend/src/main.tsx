import './i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register service worker for PWA + push notifications
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// react-dom dev ビルドの Component Tracks が発行する performance.measure が
// 自動削除されず蓄積しヒープを圧迫するため、dev では定期破棄する。
// DevTools で Performance 計測を行う際は一時的にコメントアウトしてよい。
if (import.meta.env.DEV) {
  setInterval(() => {
    performance.clearMeasures();
    performance.clearMarks();
  }, 60_000);
}
