import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import { OptionList } from './OptionList';
import { Spinner } from '../ui/Spinner';
import { isErrorResponse } from './transcriptFormat';
import type { PendingQuestionItem, TranscriptErrorResponse } from './transcriptTypes';

interface InteractionAnswerCardProps {
  windowId: number;
  paneId: string;
  /** v1 対応形と判定済みの質問1件（判定は answerableQuestion() が行う）。 */
  question: PendingQuestionItem;
  /**
   * いま表示している質問の世代識別子（pendingQuestion.openedAt）。回答リクエストに添えて、
   * サーバー側が「この質問に対する回答か」を検証できるようにする — ポーリング間隔の間に
   * 質問が別のものへ入れ替わっていた場合、数字だけでは無関係な質問を回答してしまうため。
   */
  openedAt: number;
  /**
   * 送信に失敗したことを親へ伝える。親はこのカードを畳んで従来のバナーへ切り替える —
   * 失敗の主因は「質問が既に決着していた」(409) で、その場合カードを出し続けると存在しない
   * 質問に回答できるように見えてしまう。
   */
  onAnswerFailed: () => void;
  /**
   * 送信が受理されたことを親へ伝える。サーバー側の pending は送信時点で消費されるため、
   * ポーリング応答からは質問が即座に消える — ログに回答済みエントリが現れるまでの数秒、親が
   * このカードを据え置くための合図（親側の「余韻」判定を参照）。
   */
  onAnswered: () => void;
}

/**
 * チャット内で回答できる、オープン中の AskUserQuestion カード（Issue #338）。決着済みの対話を
 * 描く InteractionCard と見た目を揃えつつ（? チップ → 質問文 → OptionList）、選択肢が押せる点だけ
 * が違う。押すと選択肢の並び順に対応する数字キー（index+1）をペインへ送出する — 実ピッカーは
 * 数字キー1発で確定するため、これがチャットからの最短の回答手段になる。
 *
 * 送信後はこのカードを「送信しました」の待ち表示に置き換えるだけで、回答内容の描画は行わない。
 * 決着した対話の正典はトランスクリプト側の interaction エントリ（✓ 付きの answered カード）で、
 * ポーリングがそれを拾った時点でこのカードごと消える（サーバー側の pending も消費済み）。
 */
export function InteractionAnswerCard({ windowId, paneId, question, openedAt, onAnswerFailed, onAnswered }: InteractionAnswerCardProps) {
  const { t } = useTranslation('transcript');
  const [sentValue, setSentValue] = useState<string | null>(null);

  const sendAnswer = useCallback(async (value: string) => {
    if (sentValue !== null) return; // 二重タップ（サーバー側も 409 で弾くが、往復を待たせない）
    setSentValue(value);
    try {
      const { status, body } = await apiWithStatus<{ ok: true } | TranscriptErrorResponse>(
        '/transcripts/window-signal',
        { method: 'POST', body: JSON.stringify({ windowId, paneId, action: 'answer', key: value, openedAt }) },
      );
      if (status !== 200 || isErrorResponse(body)) onAnswerFailed();
      else onAnswered();
    } catch {
      onAnswerFailed();
    }
  }, [sentValue, windowId, paneId, openedAt, onAnswerFailed, onAnswered]);

  const options = question.options.map((option, index) => ({
    // value = 送出する数字キー。ピッカーの並び順がそのまま 1..N の番号になる。
    value: String(index + 1),
    label: option.label,
    description: option.description,
  }));

  return (
    <div style={{ display: 'flex', justifyContent: 'center', margin: '10px 0' }}>
      <div
        style={{
          maxWidth: '90%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '10px 14px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-card)',
        }}
      >
        <span
          style={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--accent-a15)',
            color: 'var(--accent)',
            fontSize: 'var(--font-2xs)',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          <span aria-hidden="true">?</span>
          {question.header ?? t('conversation.question')}
        </span>

        <div style={{ fontSize: 'var(--font-base)', lineHeight: 1.5, color: 'var(--text)', fontWeight: 600 }}>
          {question.question}
        </div>

        <OptionList
          options={options}
          selectedValues={sentValue === null ? new Set() : new Set([sentValue])}
          onSelect={sentValue === null ? (value) => void sendAnswer(value) : () => undefined}
          focusable={sentValue === null}
        />

        {sentValue !== null ? (
          <div
            role="status"
            aria-live="polite"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-xs)', lineHeight: 1.5, color: 'var(--text-dim)' }}
          >
            <Spinner size={12} color="var(--text-dim)" />
            {t('conversation.pendingQuestion.sent')}
          </div>
        ) : (
          <div style={{ fontSize: 'var(--font-xs)', lineHeight: 1.5, color: 'var(--text-dim)' }}>
            {t('conversation.pendingQuestion.otherAnswersNote')}
          </div>
        )}
      </div>
    </div>
  );
}

export default InteractionAnswerCard;
