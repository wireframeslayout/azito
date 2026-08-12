import { useTranslation } from 'react-i18next';
import { OptionList } from '../OptionList';
import type { TranscriptEntry, TranscriptInteractionField } from '../transcriptTypes';

function answerValueFor(entry: TranscriptEntry, fieldId: string): string | undefined {
  return entry.interaction?.answers?.find((answer) => answer.fieldId === fieldId)?.value;
}

/** 'multiselect' はカンマ区切りの値（実データで確認: "煮卵, チャーシュー"）を value 集合に分解する。 */
function selectedOptionValues(field: TranscriptInteractionField, answerValue: string | undefined): Set<string> {
  if (answerValue === undefined) return new Set();
  if (field.input === 'multiselect') {
    return new Set(answerValue.split(',').map((v) => v.trim()).filter((v) => v.length > 0));
  }
  return new Set([answerValue]);
}

function InteractionField({ entry, field }: { entry: TranscriptEntry; field: TranscriptInteractionField }) {
  const { t } = useTranslation('transcript');
  const answerValue = answerValueFor(entry, field.id);
  const hasOptions = (field.options?.length ?? 0) > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 'var(--font-base)', lineHeight: 1.5, color: 'var(--text)', fontWeight: 600 }}>
        {field.label}
      </div>
      {hasOptions && <OptionList options={field.options!} selectedValues={selectedOptionValues(field, answerValue)} />}
      {/* input === 'text' は自由記述回答（実データで確認: Claude Code の「Type something」）。
          options のどのラベルとも一致しないため OptionList に反映されない — 回答文をそのまま添える。 */}
      {field.input === 'text' && answerValue !== undefined && (
        <div style={{ fontSize: 'var(--font-sm)', lineHeight: 1.5, color: 'var(--text-dim)' }}>
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{t('conversation.questionAnswerLabel')}: </span>
          {answerValue}
        </div>
      )}
    </div>
  );
}

/**
 * AskUserQuestion 由来の質問＋回答カード（Issue #338 フェーズA）。InterruptedRow/CommandRow と同じ
 * 位置付けの全表示スタイル共通コンポーネント。質問（chip＋質問文）→ OptionList（選ばれた選択肢に
 * ✓ とアクセント）→ 自由記述回答があれば回答文、の順に描画する。transcript 層は確定した Q&A のみを
 * 扱う（回答確定後にのみ生成されるエントリ）ため、未回答状態の表現は持たない。
 */
export function InteractionCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useTranslation('transcript');
  const interaction = entry.interaction;
  if (!interaction) return null;

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
          {t('conversation.question')}
        </span>

        {interaction.fields.map((field) => <InteractionField key={field.id} entry={entry} field={field} />)}
      </div>
    </div>
  );
}
