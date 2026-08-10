import { useCallback, useEffect, useState } from 'react';

/** トランスクリプトの表示スタイル。 bubble=バブル / flow=フロー / rail=ログ / tui=TUI */
export type TranscriptStyle = 'bubble' | 'flow' | 'rail' | 'tui';

export const TRANSCRIPT_STYLES: readonly TranscriptStyle[] = ['bubble', 'flow', 'rail', 'tui'];

const STORAGE_KEY = 'azito.transcript.style';
const DEFAULT_STYLE: TranscriptStyle = 'flow';

/**
 * スタイル変更をタブ内の他マウント（分割ペインで複数チャットビューを同時表示している場合等）へ
 * 即時反映するためのイベント名。`api/token.ts` の `azito:token-changed` と同じパターン
 * （setter からの window.dispatchEvent + フック側の listener）を踏襲する（Issue #69 調整1）。
 * `storage` イベントは同一タブ内の変更では発火しないため、これで自前に補う。
 */
const STYLE_CHANGED_EVENT = 'azito:transcript-style-changed';

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
 * セッション毎ではなく全セッション共通の設定として扱う。同一タブ内で複数マウントされている場合
 * （分割ペインで複数チャットビューを開いている等）、いずれか1つでの切替を STYLE_CHANGED_EVENT
 * 経由で他の全マウントへ即時反映する。
 */
export function useTranscriptStyle(): [TranscriptStyle, (style: TranscriptStyle) => void] {
  const [style, setStyleState] = useState<TranscriptStyle>(readStoredStyle);

  useEffect(() => {
    const onChanged = () => setStyleState(readStoredStyle());
    window.addEventListener(STYLE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(STYLE_CHANGED_EVENT, onChanged);
  }, []);

  const setStyle = useCallback((next: TranscriptStyle) => {
    setStyleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 上記と同様、保存できなくても表示上のスタイル切替自体は継続する。
    }
    window.dispatchEvent(new Event(STYLE_CHANGED_EVENT));
  }, []);

  return [style, setStyle];
}
