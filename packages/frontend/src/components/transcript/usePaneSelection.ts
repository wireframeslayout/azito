import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import { isErrorResponse } from './transcriptFormat';
import { resolveStoredPaneSelection, writeStoredPaneSelection } from './paneSelectionStorage';
import type { PaneCandidate, PaneCandidatesResult, TranscriptErrorResponse } from './transcriptTypes';

/** ペイン候補提示・入力送信・停止操作は tmux ペインとの cwd 突合が前提のため、現状 Claude のみ対応。 */
export const PANE_CAPABLE_AGENT_TYPE = 'claude';

export interface UsePaneSelectionResult {
  panes: PaneCandidate[];
  panesLoaded: boolean;
  panesError: string | null;
  selectedPaneId: string | null;
  selectedPane: PaneCandidate | null;
  selectPane: (pane: PaneCandidate) => void;
  retryLoadPanes: () => void;
}

/**
 * 会話ビューの送信先ペイン選択（候補取得・自動/復元選択・手動選択）。元々 PromptInputBar 内に
 * 閉じていたが、ライブ行の停止ボタン（LiveStatusRow 経由）も同じ選択状態を必要とするため
 * ConversationView 側の1フックへ抽出し、両コンポーネントへ props で渡す形にした（新規コンテキスト/
 * ストアを起こすほどの複雑さではないため、素直なリフトアップ）。
 *
 * `enabled: false`（非対応エージェント種別）の間は候補取得・状態更新を一切行わない。
 */
export function usePaneSelection(sessionId: string, enabled: boolean): UsePaneSelectionResult {
  const { t } = useTranslation('transcript');
  const [panes, setPanes] = useState<PaneCandidate[]>([]);
  const [panesLoaded, setPanesLoaded] = useState(false);
  const [panesError, setPanesError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setPanes([]);
      setPanesLoaded(false);
      setPanesError(null);
      setSelectedPaneId(null);
      return;
    }

    let cancelled = false;
    setPanesLoaded(false);
    setPanesError(null);
    setPanes([]);
    setSelectedPaneId(null);

    apiWithStatus<PaneCandidatesResult | TranscriptErrorResponse>(
      `/transcripts/${PANE_CAPABLE_AGENT_TYPE}/${encodeURIComponent(sessionId)}/panes`,
    )
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status !== 200 || isErrorResponse(body)) {
          setPanesLoaded(true);
          setPanesError(isErrorResponse(body) ? body.error : t('promptBar.loadError'));
          return;
        }
        setPanes(body.panes);
        setPanesLoaded(true);

        const storedPane = resolveStoredPaneSelection(sessionId, body.panes);
        if (storedPane) {
          setSelectedPaneId(storedPane.paneId);
          return;
        }
        const matched = body.panes.filter((p) => p.cwdMatch);
        if (matched.length === 1) {
          setSelectedPaneId(matched[0].paneId);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPanesLoaded(true);
          setPanesError(err instanceof Error ? err.message : t('promptBar.loadError'));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, enabled, reloadTick, t]);

  const retryLoadPanes = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  const selectPane = useCallback((pane: PaneCandidate) => {
    setSelectedPaneId(pane.paneId);
    writeStoredPaneSelection(sessionId, pane);
  }, [sessionId]);

  const selectedPane = panes.find((p) => p.paneId === selectedPaneId) ?? null;

  return { panes, panesLoaded, panesError, selectedPaneId, selectedPane, selectPane, retryLoadPanes };
}
