import { useCallback, useState } from 'react';

/** トランスクリプトの表示スタイル。 bubble=バブル / flow=フロー / rail=ログ / tui=TUI */
export type TranscriptStyle = 'bubble' | 'flow' | 'rail' | 'tui';

export const TRANSCRIPT_STYLES: readonly TranscriptStyle[] = ['bubble', 'flow', 'rail', 'tui'];

const STORAGE_KEY = 'azito.transcript.style';
const DEFAULT_STYLE: TranscriptStyle = 'flow';

function isTranscriptStyle(value: string | null): value is TranscriptStyle {
  return value !== null && (TRANSCRIPT_STYLES as readonly string[]).includes(value);
}

function readStoredStyle(): TranscriptStyle {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isTranscriptStyle(stored) ? stored : DEFAULT_STYLE;
  } catch {
    // プライベートブラウジング等で localStorage が使えない場合は既定スタイルにフォールバックする
    // （表示スタイルの永続化はオプション機能であり、必須データの欠落ではない）。
    return DEFAULT_STYLE;
  }
}

/**
 * トランスクリプトの表示スタイルを localStorage にグローバル保存するフック。
 * セッション毎ではなく全セッション共通の設定として扱う。
 */
export function useTranscriptStyle(): [TranscriptStyle, (style: TranscriptStyle) => void] {
  const [style, setStyleState] = useState<TranscriptStyle>(readStoredStyle);

  const setStyle = useCallback((next: TranscriptStyle) => {
    setStyleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 上記と同様、保存できなくても表示上のスタイル切替自体は継続する。
    }
  }, []);

  return [style, setStyle];
}
