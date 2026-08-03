import { useEffect, useState } from 'react';
import { useIsMobile } from './useIsMobile';

export const KEYBOARD_HEIGHT_THRESHOLD = 150;

/**
 * ソフトキーボードが出現しているかどうかを判定する。
 * window.visualViewport.height が window.innerHeight より
 * KEYBOARD_HEIGHT_THRESHOLD px 以上縮んだらキーボード出現中とみなす。
 * デスクトップでは常に false（モバイル時のみ有効）。
 */
export function useVirtualKeyboard(): boolean {
  const isMobile = useIsMobile();
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    if (!isMobile || !window.visualViewport) {
      setKeyboardVisible(false);
      return;
    }
    const vp = window.visualViewport;

    const handleResize = () => {
      const shrink = window.innerHeight - vp.height;
      setKeyboardVisible(shrink >= KEYBOARD_HEIGHT_THRESHOLD);
    };

    handleResize();
    vp.addEventListener('resize', handleResize);
    // 一部ブラウザはキーボード収納時に visualViewport の resize を発火せず
    // window の resize しか飛ばさないため、フォールバックとして window resize も監視する
    window.addEventListener('resize', handleResize);
    return () => {
      vp.removeEventListener('resize', handleResize);
      window.removeEventListener('resize', handleResize);
      setKeyboardVisible(false);
    };
  }, [isMobile]);

  return keyboardVisible;
}
