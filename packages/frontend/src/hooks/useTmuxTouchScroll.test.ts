import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachTouchScroll } from './useTmuxTouchScroll';
import { INERTIA_MIN_VELOCITY, INERTIA_HALF_LIFE_MS } from './touchScrollPhysics';

/**
 * vitest はこのワークスペースで environment: 'node' 固定（jsdom/happy-dom 未導入）。
 * capture/bubble の伝播順序と stopPropagation のみが検証対象なので、実 DOM の代わりに
 * 最小限の EventTarget 相当（親子ツリー・capture/bubble 順次呼び出し・stopPropagation）
 * をこのテストファイル内だけで用意する。
 */
type FakeListener = { handler: (e: FakeTouchEvent) => void; capture: boolean };

class FakeElement {
  parent: FakeElement | null = null;
  private children: FakeElement[] = [];
  private listeners = new Map<string, FakeListener[]>();
  private querySelectorResult: FakeElement | null = null;
  public dispatched: Array<{ type: string; deltaY: number; deltaMode: number }> = [];

  appendChild(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }

  setQuerySelectorResult(el: FakeElement | null): void {
    this.querySelectorResult = el;
  }

  querySelector(_selector: string): FakeElement | null {
    return this.querySelectorResult;
  }

  addEventListener(type: string, handler: (e: any) => void, options?: any): void {
    const capture = typeof options === 'object' ? !!options.capture : !!options;
    const list = this.listeners.get(type) ?? [];
    list.push({ handler, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (e: any) => void, options?: any): void {
    const capture = typeof options === 'object' ? !!options.capture : !!options;
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((l) => !(l.handler === handler && l.capture === capture)));
  }

  dispatchEvent(event: any): boolean {
    if (event.type === 'wheel') {
      this.dispatched.push({ type: event.type, deltaY: event.deltaY, deltaMode: event.deltaMode });
      return true;
    }

    const path: FakeElement[] = [];
    let node: FakeElement | null = this;
    while (node) {
      path.push(node);
      node = node.parent;
    }
    path.reverse(); // root -> target

    for (const n of path) {
      for (const l of n.listeners.get(event.type) ?? []) {
        if (!l.capture) continue;
        l.handler(event);
        if (event.__stopped) return true;
      }
    }
    for (const n of [...path].reverse()) {
      for (const l of n.listeners.get(event.type) ?? []) {
        if (l.capture) continue;
        l.handler(event);
        if (event.__stopped) return true;
      }
    }
    return true;
  }
}

class FakeTouchEvent {
  type: string;
  touches: Array<{ clientX: number; clientY: number }>;
  timeStamp: number;
  __stopped = false;
  __defaultPrevented = false;

  constructor(type: string, touches: Array<{ clientX: number; clientY: number }>, timeStamp: number) {
    this.type = type;
    this.touches = touches;
    this.timeStamp = timeStamp;
  }

  stopPropagation(): void {
    this.__stopped = true;
  }

  preventDefault(): void {
    this.__defaultPrevented = true;
  }
}

class FakeWheelEvent {
  static DOM_DELTA_PIXEL = 0;
  type: string;
  deltaY: number;
  deltaMode: number;
  bubbles: boolean;
  cancelable: boolean;

  constructor(type: string, init: { deltaY: number; deltaMode: number; bubbles: boolean; cancelable: boolean }) {
    this.type = type;
    this.deltaY = init.deltaY;
    this.deltaMode = init.deltaMode;
    this.bubbles = init.bubbles;
    this.cancelable = init.cancelable;
  }
}

let rafQueue: Array<{ id: number; cb: (t: number) => void }> = [];
let rafIdSeq = 1;

function flushRaf(timestamp: number): void {
  const queue = rafQueue;
  rafQueue = [];
  for (const { cb } of queue) cb(timestamp);
}

function touch(clientY: number, clientX = 0): Array<{ clientX: number; clientY: number }> {
  return [{ clientX, clientY }];
}

function twoTouches(clientY: number, clientX = 0): Array<{ clientX: number; clientY: number }> {
  return [{ clientX, clientY }, { clientX: clientX + 50, clientY: clientY + 50 }];
}

beforeEach(() => {
  rafQueue = [];
  rafIdSeq = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    const id = rafIdSeq++;
    rafQueue.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue = rafQueue.filter((item) => item.id !== id);
  });
  vi.stubGlobal('WheelEvent', FakeWheelEvent);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('attachTouchScroll', () => {
  it('rAF flush 1回につき wheel dispatch は1件、deltaY は蓄積合計に一致する(DOM_DELTA_PIXEL)', () => {
    const container = new FakeElement();
    attachTouchScroll(container as unknown as HTMLElement);

    container.dispatchEvent(new FakeTouchEvent('touchstart', touch(100), 0));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(85), 15));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(70), 30));

    expect(container.dispatched).toHaveLength(0);
    flushRaf(31);

    expect(container.dispatched).toHaveLength(1);
    expect(container.dispatched[0].deltaY).toBe(30); // (100-85) + (85-70)
    expect(container.dispatched[0].deltaMode).toBe(FakeWheelEvent.DOM_DELTA_PIXEL);
  });

  it('capture phase で stopPropagation され、container 内部の子要素のリスナーに touch イベントが届かない', () => {
    const container = new FakeElement();
    const child = new FakeElement();
    container.appendChild(child);
    attachTouchScroll(container as unknown as HTMLElement);

    const childHandler = vi.fn();
    child.addEventListener('touchstart', childHandler, { capture: false });

    child.dispatchEvent(new FakeTouchEvent('touchstart', touch(100), 0));

    expect(childHandler).not.toHaveBeenCalled();
  });

  it('横スワイプでは wheel が dispatch されない(方向ロック)', () => {
    const container = new FakeElement();
    attachTouchScroll(container as unknown as HTMLElement);

    container.dispatchEvent(new FakeTouchEvent('touchstart', touch(100, 0), 0));
    // X方向の移動がY方向より大きい -> 横ロック
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(98, 20), 15));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(95, 40), 30));
    flushRaf(31);

    expect(container.dispatched).toHaveLength(0);
  });

  it('閾値(10px)超過前の蓄積移動量も失われず最初の wheel に含まれる', () => {
    const container = new FakeElement();
    attachTouchScroll(container as unknown as HTMLElement);

    container.dispatchEvent(new FakeTouchEvent('touchstart', touch(100), 0));
    // 閾値未満の小さい移動(totalDeltaY=5 <= 10) : まだ scrolling=false
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(95), 15));
    // 閾値を超える(totalDeltaY=15 > 10): scrolling=true に切り替わる
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(85), 30));
    flushRaf(31);

    expect(container.dispatched).toHaveLength(1);
    // (100-95) + (95-85) = 5 + 10 = 15。閾値未満だった最初の5pxも含まれる
    expect(container.dispatched[0].deltaY).toBe(15);
  });

  it('touchcancel で慣性が始まらず、保留中の delta が破棄される', () => {
    const container = new FakeElement();
    attachTouchScroll(container as unknown as HTMLElement);

    container.dispatchEvent(new FakeTouchEvent('touchstart', touch(100), 0));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(85), 15));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(70), 30));
    container.dispatchEvent(new FakeTouchEvent('touchcancel', touch(70), 31));

    // 保留中だった flush の rAF もキャンセルされている
    flushRaf(60);
    expect(container.dispatched).toHaveLength(0);

    // 慣性も一切開始しない
    flushRaf(90);
    flushRaf(120);
    expect(container.dispatched).toHaveLength(0);
  });

  it('マルチタッチで reset された後、指が1本に戻って move/end しても新しい touchstart が来るまでは無視される', () => {
    const container = new FakeElement();
    attachTouchScroll(container as unknown as HTMLElement);

    // 1本指で通常のスクロール操作を開始
    container.dispatchEvent(new FakeTouchEvent('touchstart', touch(500), 0));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(490), 10));

    // 2本目の指が触れる(pinch等) -> resetGesture() で gestureActive が false になる
    container.dispatchEvent(new FakeTouchEvent('touchmove', twoTouches(490), 20));

    // 2本目の指を離して1本に戻る。新しい touchstart は来ていないため、
    // stale な startX/startY/lastY(=500,0付近)との差分で大ジャンプの wheel が
    // 出てはいけない。ここでは大きく離れた座標(y=50)への move を送る。
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(50), 30));
    flushRaf(31);
    expect(container.dispatched).toHaveLength(0);

    // 同様に touchend も無視され、慣性も開始しない
    container.dispatchEvent(new FakeTouchEvent('touchend', touch(50), 35));
    flushRaf(51);
    flushRaf(67);
    expect(container.dispatched).toHaveLength(0);
    expect(rafQueue.length).toBe(0);

    // 新しい touchstart が来れば通常どおりジェスチャが再開する
    container.dispatchEvent(new FakeTouchEvent('touchstart', touch(50), 40));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(20), 55));
    flushRaf(56);
    expect(container.dispatched).toHaveLength(1);
    expect(container.dispatched[0].deltaY).toBe(30); // 50 - 20
  });

  it('touchend 後、十分な速度があれば rAF を数回 flush すると wheel が継続 dispatch される(慣性)。新しい touchstart で止まる', () => {
    const container = new FakeElement();
    attachTouchScroll(container as unknown as HTMLElement);

    // 速い縦スワイプ: 15px/5ms 前後の速度になるよう複数 touchmove を送る
    container.dispatchEvent(new FakeTouchEvent('touchstart', touch(200), 0));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(185), 5));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(170), 10));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(155), 15));
    flushRaf(16); // スクロール中の通常 flush を消化

    const dispatchedBeforeEnd = container.dispatched.length;
    container.dispatchEvent(new FakeTouchEvent('touchend', touch(155), 20));

    // 慣性の velocityAt が INERTIA_MIN_VELOCITY 未満なら本テストは前提が崩れるため確認
    expect(rafQueue.length).toBeGreaterThan(0);

    flushRaf(32); // 慣性ステップ1
    flushRaf(48); // 慣性ステップ2
    expect(container.dispatched.length).toBeGreaterThan(dispatchedBeforeEnd + 1);

    const dispatchedBeforeNewTouch = container.dispatched.length;
    container.dispatchEvent(new FakeTouchEvent('touchstart', touch(155), 60));
    flushRaf(64);
    flushRaf(80);
    expect(container.dispatched.length).toBe(dispatchedBeforeNewTouch);
  });

  it('cap を超えた delta は次フレームの wheel に持ち越される', () => {
    const container = new FakeElement();
    attachTouchScroll(container as unknown as HTMLElement);

    container.dispatchEvent(new FakeTouchEvent('touchstart', touch(10000), 0));
    // 1回の touchmove で MAX_DELTA_PER_FRAME(2000px) を大きく超える移動
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(10000 - 15, 0), 15));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(10000 - 15 - 3000, 0), 30));
    flushRaf(31);

    expect(container.dispatched).toHaveLength(1);
    expect(container.dispatched[0].deltaY).toBe(2000);

    // 超過分(1015px)は蓄積に残っており、次フレームの flush で出てくる
    flushRaf(47);
    expect(container.dispatched).toHaveLength(2);
    expect(container.dispatched[1].deltaY).toBe(1015);
  });

  it('touchstart で速度サンプルが seed され、touchmove が1回だけでも touchend で慣性が働く', () => {
    const container = new FakeElement();
    attachTouchScroll(container as unknown as HTMLElement);

    // touchstart(200,t=0) が速度サンプルとして記録されるため、touchmove 1回(170,t=5)
    // だけで2サンプル揃い、慣性計算が可能になる。
    container.dispatchEvent(new FakeTouchEvent('touchstart', touch(200), 0));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(170), 5));
    flushRaf(16); // 通常スクロールの flush を消化

    const dispatchedBeforeEnd = container.dispatched.length;
    container.dispatchEvent(new FakeTouchEvent('touchend', touch(170), 10));

    // 慣性の rAF がスケジュールされている(=速度が seed され、閾値以上と判定された)ことを確認
    expect(rafQueue.length).toBeGreaterThan(0);

    flushRaf(26);
    expect(container.dispatched.length).toBeGreaterThan(dispatchedBeforeEnd);
  });

  it('touchend 後に cap 超過の残余があっても、scrolling=false になった後も drain され続ける', () => {
    const container = new FakeElement();
    attachTouchScroll(container as unknown as HTMLElement);

    container.dispatchEvent(new FakeTouchEvent('touchstart', touch(10000), 0));
    // scrolling を true にする最初の小さい move
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(10000 - 15, 0), 15));
    // MAX_DELTA_PER_FRAME(2000px) を大きく超える移動を積む(まだ flush されていない状態)
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(10000 - 15 - 3000, 0), 20));

    // touchend の timeStamp を最後の move から80ms以上離し、慣性(velocityAt)が発生しない
    // (=このテストは cap 残余の drain のみを検証する)状態にする。
    container.dispatchEvent(new FakeTouchEvent('touchend', touch(10000 - 15 - 3000, 0), 200));

    // touchend で scrolling=false になった後、最初にスケジュール済みだった flush が実行される
    flushRaf(216);
    expect(container.dispatched).toHaveLength(1);
    expect(container.dispatched[0].deltaY).toBe(2000);

    // 残余(1015px)は scrolling=false でも取りこぼされず、自走 flush で drain される
    flushRaf(232);
    expect(container.dispatched).toHaveLength(2);
    expect(container.dispatched[1].deltaY).toBe(1015);
  });

  it('慣性の最初のフレームが極端に遅延し、cap超過と速度閾値割れが同時に起きても残余が最後まで drain される', () => {
    const container = new FakeElement();
    attachTouchScroll(container as unknown as HTMLElement);

    // 非常に速いフリックを作る(positionVelocity = -50px/ms 相当)
    const seedY = 1000000;
    container.dispatchEvent(new FakeTouchEvent('touchstart', touch(seedY), 0));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(seedY - 250), 5));
    flushRaf(6); // seeding move の通常 flush を消化
    container.dispatched.length = 0;

    container.dispatchEvent(new FakeTouchEvent('touchend', touch(seedY - 250), 10));
    expect(rafQueue.length).toBeGreaterThan(0); // 慣性が開始していることの前提確認

    // タブ停止等を模した極端な遅延。半減期の20倍(0.5^20 ≈ 9.5e-7)なら、
    // 初速がどれだけ大きくても INERTIA_MIN_VELOCITY を確実に下回る一方、
    // 解析積分後の変位は cap(2000px) を大きく超える(= 1フレームで両方同時に起きる)。
    const staleDelayMs = INERTIA_HALF_LIFE_MS * 20;
    flushRaf(10 + staleDelayMs);

    expect(container.dispatched).toHaveLength(1);
    expect(container.dispatched[0].deltaY).toBe(2000); // cap で切られた1回目

    // 慣性ループはこのフレームで終了しているが、cap超過分の残余は
    // stranded にならず、自走 flush で drain され続ける。
    flushRaf(10 + staleDelayMs + 16);
    expect(container.dispatched).toHaveLength(2);
    expect(container.dispatched[1].deltaY).toBeGreaterThan(0);

    // さらに残余があれば追加のフレームでも drain され、最終的に accumulator が空になる
    let guard = 0;
    while (rafQueue.length > 0 && guard < 30) {
      flushRaf(10 + staleDelayMs + 16 + guard * 16);
      guard += 1;
    }
    const total = container.dispatched.reduce((sum, d) => sum + d.deltaY, 0);
    expect(total).toBeGreaterThan(2000); // capを超えた総量が最終的にすべて dispatch された
  });
});

describe('startInertia の解析積分', () => {
  /**
   * 同じ初速から出発した慣性の総変位が、フレーム分割の粒度(通常フレーム/倍速フレーム/
   * 遅延フレーム+通常フレーム)によらずほぼ一致することを検証する。
   * 線形近似(velocity * frameDt)だと遅延フレームで過大積分されるが、解析的な指数積分
   * (v * τ * (1 - e^(-dt/τ)))は経過時間のみに依存するため、分割によらず一致するはず。
   */
  function collectInertiaDisplacement(frameDts: number[]): number {
    const container = new FakeElement();
    attachTouchScroll(container as unknown as HTMLElement);

    const seedY = 100000;
    const moveDeltaY = 15; // SCROLL_THRESHOLD(10)を超える移動
    const moveDt = 5;
    container.dispatchEvent(new FakeTouchEvent('touchstart', touch(seedY), 0));
    container.dispatchEvent(new FakeTouchEvent('touchmove', touch(seedY - moveDeltaY), moveDt));
    flushRaf(moveDt + 1); // seeding move の通常 flush を消化(慣性の集計から除外する)
    container.dispatched.length = 0;

    const touchEndTimestamp = moveDt + 5;
    container.dispatchEvent(new FakeTouchEvent('touchend', touch(seedY - moveDeltaY), touchEndTimestamp));
    expect(rafQueue.length).toBeGreaterThan(0); // 慣性が開始していることの前提確認

    let t = touchEndTimestamp;
    for (const dt of frameDts) {
      t += dt;
      flushRaf(t);
    }

    return container.dispatched.reduce((sum, d) => sum + d.deltaY, 0);
  }

  it('16.67ms刻み・8.33ms刻み・長い遅延フレーム+通常フレームの総変位がほぼ一致する', () => {
    // 半減期(150ms)に対して十分小さく、INERTIA_MIN_VELOCITY を下回って慣性が
    // 途中終了しない範囲の総経過時間(300ms)を採用する。
    const totalMs = 300;
    expect(totalMs).toBeLessThan(INERTIA_HALF_LIFE_MS * 3); // 早期終了しないことの前提メモ

    const framesNormal = Array.from({ length: 18 }, () => totalMs / 18); // 16.6667ms x18
    const framesDouble = Array.from({ length: 36 }, () => totalMs / 36); // 8.3333ms x36
    const framesStalled = [totalMs - totalMs / 18, totalMs / 18]; // 長い遅延フレーム + 通常フレーム1回

    const dispNormal = collectInertiaDisplacement(framesNormal);
    const dispDouble = collectInertiaDisplacement(framesDouble);
    const dispStalled = collectInertiaDisplacement(framesStalled);

    expect(dispNormal).toBeCloseTo(dispDouble, 5);
    expect(dispNormal).toBeCloseTo(dispStalled, 5);
  });
});

// INERTIA_MIN_VELOCITY を直接参照し、慣性テストの前提(十分な速度)が定数と矛盾しないことを明示する
it('INERTIA_MIN_VELOCITY は正の値である(慣性テストの前提)', () => {
  expect(INERTIA_MIN_VELOCITY).toBeGreaterThan(0);
});
