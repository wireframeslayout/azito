import type { PendingQuestion, PendingQuestionItem } from './transcriptTypes';

/** 数字キー1発で回答できる選択肢の上限（ピッカーの 1〜9 と一致）。 */
const MAX_TAPPABLE_OPTIONS = 9;

/**
 * チャット内で回答できる形（v1 対応形）の質問だけを取り出す。条件は「質問が1件」「multiSelect で
 * ない」「選択肢が1〜9件」の3つ — いずれも “選択肢の並び順に対応する数字キー1発でピッカーが確定
 * する” という前提そのもので、複数質問（質問間の遷移が要る）・複数選択（確定に Enter が要る）・
 * 10件以上（2桁入力になる）はこの前提を満たさない。満たさない質問は従来どおりバナーへ倒す。
 */
export function answerableQuestion(pendingQuestion: PendingQuestion | null): PendingQuestionItem | null {
  if (pendingQuestion === null || pendingQuestion.questions.length !== 1) return null;
  const question = pendingQuestion.questions[0];
  if (question.multiSelect) return null;
  if (question.options.length < 1 || question.options.length > MAX_TAPPABLE_OPTIONS) return null;
  return question;
}
