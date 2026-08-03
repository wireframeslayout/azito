import type { SubagentConfig } from '../units/Unit';
import { buildWorkerLaunchCommand, buildHeadlessLaunchCommand, shellQuote } from '../agents/LaunchCommand';
import {
  stateMachineEnvelope,
  skillEnvelope,
  httpSignalEnvelope,
  type StateMachineEnvelopeOpts,
  type SkillEnvelopeOpts,
  type HttpSignalEnvelopeOpts,
} from './executionEnvelope';

export type RenderForStateMachineOpts = StateMachineEnvelopeOpts;

export type RenderForSkillOpts = SkillEnvelopeOpts;

export type RenderForHttpSignalOpts = HttpSignalEnvelopeOpts;

/**
 * Renders a Sidekick body for the state-machine execution context.
 *
 * The legacy PHASE_COMPLETE/QUESTIONS_JSON/TEST_FAILED token replacement is
 * kept for backward compatibility: user-layer Sidekick packages authored
 * before Issue #263 Refine D may still contain these tokens in their body.
 * Replacing them with the same markers the envelope itself references keeps
 * old and new bodies consistent — a legacy body's inline token becomes the
 * exact marker the envelope's completion_signal block also uses, so there is
 * no contradiction between the two. New bodies (with no such tokens) rely on
 * the envelope alone, which is a self-contained contract on its own (see
 * executionEnvelope.ts).
 */
export function renderForStateMachine(
  expandedBody: string,
  opts: RenderForStateMachineOpts,
): string {
  const { doneMarker, questionsMarker, testFailedMarker } = opts;

  const markerized = expandedBody
    .replace(/PHASE_COMPLETE/g, doneMarker)
    .replace(/QUESTIONS_JSON/g, questionsMarker)
    .replace(/TEST_FAILED/g, testFailedMarker);

  return stateMachineEnvelope(opts).wrap(markerized);
}

/**
 * Renders a Sidekick body for the http-signal execution context. No legacy
 * PHASE_COMPLETE/QUESTIONS_JSON/TEST_FAILED token replacement is needed here —
 * those tokens only ever referred to the state-machine's echo-marker mechanism,
 * which http-signal does not use; a body relies on httpSignalEnvelope alone.
 */
export function renderForHttpSignal(
  expandedBody: string,
  opts: RenderForHttpSignalOpts,
): string {
  return httpSignalEnvelope(opts).wrap(expandedBody);
}

export interface ReviewModules {
  reviewPerspectives: string;
  /** 言語横断の実装ルール（PromptModules.implementationRules）。空文字可。 */
  implementationRules: string;
}

export interface ImplementModules {
  softwareDesignPrinciples: string;
  uiDesignPrinciples: string;
  /** 言語横断の実装ルール（PromptModules.implementationRules）。空文字可。 */
  implementationRules: string;
}

/**
 * サブエージェントに渡すルールファイルの中身を組み立てる。
 * このテキストはサーバーがターゲット環境のファイルへ直接書き込み、
 * 委任ブロックではそのパスを参照させる（親エージェントが本文を転記しない）。
 */
export function buildSubagentRulesFileContent(role: 'review', modules: ReviewModules): string;
export function buildSubagentRulesFileContent(role: 'implement', modules: ImplementModules): string;
export function buildSubagentRulesFileContent(
  role: 'review' | 'implement',
  modules: ReviewModules | ImplementModules,
): string {
  const sections: string[] = [];
  if (role === 'review') {
    const { reviewPerspectives } = modules as ReviewModules;
    sections.push('# サブエージェント向けレビュールール');
    sections.push('以下のルール・観点をすべて厳守してレビューすること。');
    sections.push('## レビュー観点');
    sections.push(reviewPerspectives);
  } else {
    const { softwareDesignPrinciples, uiDesignPrinciples } = modules as ImplementModules;
    sections.push('# サブエージェント向け実装ルール');
    sections.push('以下のルール・設計原則をすべて厳守して実装すること。');
    sections.push('## ソフトウェア設計原則');
    sections.push(softwareDesignPrinciples);
    sections.push('## UI 設計原則');
    sections.push(uiDesignPrinciples);
  }
  const { implementationRules } = modules;
  if (implementationRules.trim().length > 0) {
    sections.push('## 共通実装ルール');
    sections.push(implementationRules);
  }
  return sections.join('\n\n');
}

/**
 * 委任ブロックを組み立てる。ルール本文は埋め込まず、サーバーが書き出した
 * rulesFilePath を「サブエージェントに最初に必読させる」よう親エージェントへ指示する。
 * これにより親による長文の転記漏れ・要約に依存せず、確実にルールが届く。
 */
export function buildSubagentDelegationBlock(
  role: 'review' | 'implement',
  config: SubagentConfig,
  workerType: string,
  rulesFilePath: string,
): string {
  const isNative = config.provider === workerType;
  const headlessCmd = isNative ? null : buildHeadlessLaunchCommand(config.provider, config.model);
  const interactiveCmd = buildWorkerLaunchCommand(config.provider, config.model, null)
    ?? `${config.provider} --model ${shellQuote(config.model)}`;

  const roleWord = role === 'review' ? 'レビュー' : '実装';
  const intro = `重要: このフェーズの${roleWord}は、必ず ${config.provider}（${config.model}）のサブエージェントに委任してください。あなた自身で${roleWord}してはいけません。オーバーヘッドやトークンコストを理由に委任を省略しないでください — ${roleWord}を別コンテキストに分離することで、最終的なトークンコストはむしろ削減されます。`;

  // ルールはサーバーがファイルに書き出し済み。本文を転記せず、必ず最初に読ませる。
  const ruleHandoff = `${roleWord}に適用すべきルール・設計原則${role === 'review' ? '・レビュー観点' : ''}は ${rulesFilePath} にすべて用意済みです（あなたがルール本文を転記する必要はありません）。サブエージェントには必ず「最初に ${rulesFilePath} を読み、そこに書かれた内容をすべて厳守してから作業すること」と明示的に指示してください。`;

  // タスク固有の情報（ルールとは別）。これは親自身のプロンプトから渡す。
  const contextHandoff = role === 'review'
    ? 'レビュー対象の変更差分（例: `git diff` や対象ブランチとの差分）をサブエージェントに伝える。'
    : 'このタスクの実装指示（タイトル・詳細・計画）をサブエージェントに伝える。';

  let launchStep: string;
  if (isNative) {
    launchStep = `ネイティブなサブエージェント機能（Agent ツール等）を使って、${config.provider}（モデル: ${config.model}）に${roleWord}を委譲する。`;
  } else if (headlessCmd) {
    launchStep = `次のコマンドでサブエージェントをヘッドレスモードで実行する:\n   ${headlessCmd}`;
  } else {
    launchStep = `次のコマンドでサブエージェントを対話モードで起動する:\n   ${interactiveCmd}`;
  }

  const resultStep = role === 'review'
    ? 'サブエージェントの指摘を受け取り、コードに反映してから、このフェーズの完了を報告する。'
    : 'サブエージェントの実装結果を受け取り、検証・統合してから、このフェーズの完了を報告する。';

  return `\n\n<subagent_delegation>
${intro}

このフェーズの最初のアクションとして、必ず次の手順を順番に実行してください:
1. ${launchStep}
2. ${ruleHandoff}
3. ${contextHandoff}
4. ${resultStep}
</subagent_delegation>`;
}

/**
 * Renders a Sidekick body for the skill execution context (harness azt-*
 * skills). Legacy token replacement (PHASE_COMPLETE etc. -> natural language)
 * is kept for the same backward-compatibility reason as renderForStateMachine
 * — old user-layer bodies still authored with these tokens humanize cleanly.
 * New bodies rely on skillEnvelope alone for the natural-language protocol.
 */
export function renderForSkill(expandedBody: string, opts: RenderForSkillOpts): string {
  const humanized = expandedBody
    .replace(/PHASE_COMPLETE/g, 'タスクが完了したら、その旨を報告してください')
    .replace(/QUESTION:/g, '質問がある場合は、ユーザーに直接質問してください:')
    .replace(/QUESTIONS_JSON/g, '質問がある場合は、明確に質問してください')
    .replace(/TEST_FAILED:/g, 'テストが失敗した場合は、その内容を報告してください:');

  return skillEnvelope(opts).wrap(humanized);
}
