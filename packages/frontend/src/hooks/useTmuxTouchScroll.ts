import { useEffect } from 'react';
import {
  VelocityTracker,
  DeltaAccumulator,
  decayVelocity,
  INERTIA_MIN_VELOCITY,
  INERTIA_HALF_LIFE_MS,
} from './touchScrollPhysics';

/** 指数減衰の時定数(ms)。半減期から変換: τ = half-life / ln(2) */
const INERTIA_TAU_MS = INERTIA_HALF_LIFE_MS / Math.LN2;

interface UseTmuxTouchScrollOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
}

const SCROLL_THRESHOLD = 10;
/** 1フレームで dispatch する wheel の絶対値cap(px)。超過分は次フレームへ持ち越す */
const MAX_DELTA_PER_FRAME = 2000;

export function useTmuxTouchScroll({ containerRef }: UseTmuxTouchScrollOptions): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return attachTouchScroll(container);
  }, [containerRef]);
}

/**
 * container に capture phase でタッチリスナーを登録し、1ジェスチャを rAF 集約の
 * DOM_DELTA_PIXEL wheel イベント列に変換する。xterm.js 5.5 は container 内部の要素
 * (`.xterm-viewport` 等) に自前の touch リスナーを持ち、同一ジェスチャを synthetic wheel
 * と二重処理してしまうため、capture phase + stopPropagation でジェスチャの所有権を
 * このフックに一本化する（xterm 内蔵リスナーへイベントを届けない）。
 *
 * フック本体から切り出した純関数（container のみに依存）にして、テストから
 * React のレンダーサイクルを介さず直接呼び出せるようにしている。
 */
export function attachTouchScroll(container: HTMLElement): () => void {
  const velocityTracker = new VelocityTracker();
  const accumulator = new DeltaAccumulator();

  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let directionLocked = false;
  let isHorizontal = false;
  let scrolling = false;
  let flushRafId: number | null = null;
  let inertiaRafId: number | null = null;
  // 単一タッチの touchstart で true、resetGesture() で false になる。
  // マルチタッチで resetGesture() した後、指が1本に戻っても新しい touchstart が
  // 来るまではジェスチャを再開しない(残った指の stale な startX/startY/lastY を
  // 使って大ジャンプの wheel が出るのを防ぐため)。
  let gestureActive = false;

  function getWheelTarget(): Element {
    return container.querySelector('.xterm-viewport') ?? container;
  }

  function dispatchWheel(deltaY: number): void {
    getWheelTarget().dispatchEvent(new WheelEvent('wheel', {
      deltaY,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      bubbles: true,
      cancelable: true,
    }));
  }

  function flush(): void {
    const delta = accumulator.take(MAX_DELTA_PER_FRAME);
    if (delta === 0) return;
    dispatchWheel(delta);
    // cap で削り切れず accumulator に残った分は、次の touchmove を待たずに
    // 自走して drain する（高速スワイプの cap 超過分を取りこぼさないため）。
    // scrolling に依存させない: touchend 直後(scrolling=false)でも残余があれば drain する。
    // 慣性ループ稼働中(inertiaRafId !== null)はループ自身が毎フレーム flush するため、
    // ここでの二重スケジュールは避ける。
    if (accumulator.pending !== 0 && inertiaRafId === null) scheduleFlush();
  }

  function scheduleFlush(): void {
    if (flushRafId !== null) return;
    flushRafId = requestAnimationFrame(() => {
      flushRafId = null;
      flush();
    });
  }

  function stopInertia(): void {
    if (inertiaRafId === null) return;
    cancelAnimationFrame(inertiaRafId);
    inertiaRafId = null;
  }

  function stopFlush(): void {
    if (flushRafId === null) return;
    cancelAnimationFrame(flushRafId);
    flushRafId = null;
  }

  function resetGesture(): void {
    stopInertia();
    stopFlush();
    accumulator.reset();
    velocityTracker.reset();
    scrolling = false;
    directionLocked = false;
    isHorizontal = false;
    gestureActive = false;
  }

  function startInertia(initialVelocity: number, startTime: number): void {
    let velocity = initialVelocity;
    let prevTimestamp = startTime;

    function step(timestamp: number): void {
      const frameDt = timestamp - prevTimestamp;
      prevTimestamp = timestamp;
      // フレーム区間 [0, frameDt] の指数減衰速度を解析的に積分した変位。
      // 遅延フレーム(タブ停止等で frameDt が大きい)でも初速のまま線形積分せず、
      // 実際に減衰した分だけを変位として計上する。
      // ∫[0,frameDt] v * e^(-t/τ) dt = v * τ * (1 - e^(-frameDt/τ))
      accumulator.add(velocity * INERTIA_TAU_MS * (1 - Math.exp(-frameDt / INERTIA_TAU_MS)));
      velocity = decayVelocity(velocity, frameDt);
      flush();
      if (Math.abs(velocity) < INERTIA_MIN_VELOCITY) {
        inertiaRafId = null;
        // 慣性終了フレームで cap 超過(2000px)と速度閾値割れが同時に起きると、
        // 上の flush() 実行時点ではまだ inertiaRafId が非null(自走スケジュール条件を
        // 満たさない)ため残余が drain されない。inertiaRafId を null 化した直後に
        // 改めて確認し、残余があれば自走 drain に乗せる。
        if (accumulator.pending !== 0) scheduleFlush();
        return;
      }
      inertiaRafId = requestAnimationFrame(step);
    }

    inertiaRafId = requestAnimationFrame(step);
  }

  function handleTouchStart(e: TouchEvent): void {
    e.stopPropagation();
    resetGesture();
    if (e.touches.length > 1) return;
    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    lastY = touch.clientY;
    gestureActive = true;
    // 初期位置を速度推定のサンプルとして記録しておく。touchmove が1回しか
    // 来ない短いフリックでも2サンプル揃い、慣性が働くようにするため。
    velocityTracker.add(touch.clientY, e.timeStamp);
  }

  function handleTouchMove(e: TouchEvent): void {
    e.stopPropagation();
    if (e.touches.length > 1) {
      resetGesture();
      return;
    }
    if (!gestureActive) return;

    const touch = e.touches[0];
    const deltaY = lastY - touch.clientY;
    const totalDeltaY = Math.abs(touch.clientY - startY);
    const totalDeltaX = Math.abs(touch.clientX - startX);
    lastY = touch.clientY;

    if (!directionLocked && (totalDeltaX > SCROLL_THRESHOLD || totalDeltaY > SCROLL_THRESHOLD)) {
      directionLocked = true;
      isHorizontal = totalDeltaX > totalDeltaY;
    }
    if (isHorizontal) return;

    // 方向確定前の移動量も蓄積しておく。閾値超過の瞬間に scrolling が true になった
    // 最初の flush で、それまでの移動量ごと wheel として送出されるようにするため。
    accumulator.add(deltaY);
    velocityTracker.add(touch.clientY, e.timeStamp);

    if (!scrolling && totalDeltaY > SCROLL_THRESHOLD) {
      scrolling = true;
    }
    if (!scrolling) return;

    e.preventDefault();
    scheduleFlush();
  }

  function handleTouchEnd(e: TouchEvent): void {
    e.stopPropagation();
    if (!gestureActive) return;
    const wasScrolling = scrolling;
    scrolling = false;
    if (!wasScrolling) return;

    // 位置の速度(px/ms, 下方向=正)は touchmove の deltaY 蓄積(上方向移動=正)と符号が逆。
    const positionVelocity = velocityTracker.velocityAt(e.timeStamp);
    if (Math.abs(positionVelocity) < INERTIA_MIN_VELOCITY) return;
    startInertia(-positionVelocity, e.timeStamp);
  }

  function handleTouchCancel(e: TouchEvent): void {
    e.stopPropagation();
    resetGesture();
  }

  container.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
  container.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
  container.addEventListener('touchend', handleTouchEnd, { capture: true, passive: true });
  container.addEventListener('touchcancel', handleTouchCancel, { capture: true, passive: true });

  return () => {
    container.removeEventListener('touchstart', handleTouchStart, { capture: true });
    container.removeEventListener('touchmove', handleTouchMove, { capture: true });
    container.removeEventListener('touchend', handleTouchEnd, { capture: true });
    container.removeEventListener('touchcancel', handleTouchCancel, { capture: true });
    resetGesture();
  };
}
