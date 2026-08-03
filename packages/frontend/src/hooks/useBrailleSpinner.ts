import { useEffect, useState } from 'react';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 90;

/**
 * braille スピナーの現在フレームを返す共有フック。
 *
 * 呼び出しコンポーネント数に関わらず setInterval は1つだけ生成する
 * （モジュールスコープの購読者リストで tick を配信）。`prefers-reduced-motion: reduce`
 * のときは interval を起動せず、常に最初のフレームを返す。
 */
let sharedIndex = 0;
let sharedTimer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(index: number) => void>();

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function subscribe(callback: (index: number) => void): () => void {
  subscribers.add(callback);
  if (subscribers.size === 1 && sharedTimer === null && !prefersReducedMotion()) {
    sharedTimer = setInterval(() => {
      sharedIndex = (sharedIndex + 1) % FRAMES.length;
      for (const sub of subscribers) sub(sharedIndex);
    }, INTERVAL_MS);
  }
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0 && sharedTimer !== null) {
      clearInterval(sharedTimer);
      sharedTimer = null;
    }
  };
}

/** 現在の braille スピナー文字（reduced-motion時は固定フレーム）を返す */
export function useBrailleSpinner(): string {
  const [index, setIndex] = useState(sharedIndex);

  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    return subscribe(setIndex);
  }, []);

  return prefersReducedMotion() ? FRAMES[0] : FRAMES[index];
}
