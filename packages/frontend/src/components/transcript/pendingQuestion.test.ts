import { describe, it, expect } from 'vitest';
import { answerableQuestion } from './pendingQuestion';
import type { PendingQuestion, PendingQuestionItem } from './transcriptTypes';

function makeQuestion(overrides: Partial<PendingQuestionItem> = {}): PendingQuestionItem {
  return { question: 'どれにしますか?', multiSelect: false, options: [{ label: 'はい' }, { label: 'いいえ' }], ...overrides };
}

function makePending(questions: PendingQuestionItem[]): PendingQuestion {
  return { questions, openedAt: 1_000 };
}

describe('answerableQuestion', () => {
  it('質問1件・単一選択・選択肢2件はチャットで回答できる', () => {
    const question = makeQuestion();
    expect(answerableQuestion(makePending([question]))).toBe(question);
  });

  it('選択肢9件までは回答できる', () => {
    const question = makeQuestion({ options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })) });
    expect(answerableQuestion(makePending([question]))).toBe(question);
  });

  it('選択肢が10件以上なら回答できない（2桁入力になる）', () => {
    const question = makeQuestion({ options: Array.from({ length: 10 }, (_, i) => ({ label: `o${i}` })) });
    expect(answerableQuestion(makePending([question]))).toBeNull();
  });

  it('選択肢が0件なら回答できない', () => {
    expect(answerableQuestion(makePending([makeQuestion({ options: [] })]))).toBeNull();
  });

  it('multiSelect は回答できない（確定に Enter が要る）', () => {
    expect(answerableQuestion(makePending([makeQuestion({ multiSelect: true })]))).toBeNull();
  });

  it('質問が複数なら回答できない', () => {
    expect(answerableQuestion(makePending([makeQuestion(), makeQuestion()]))).toBeNull();
  });

  it('質問が0件なら回答できない', () => {
    expect(answerableQuestion(makePending([]))).toBeNull();
  });

  it('質問内容そのものが無い（バナー相当）なら回答できない', () => {
    expect(answerableQuestion(null)).toBeNull();
  });
});
