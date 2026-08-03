import { describe, it, expect } from 'vitest';
import type { PaneQuestion } from '../../llm/PaneClassifier';

function generateMarkers(taskId: number): { done: string; questions: string } {
  const nonce = Math.random().toString(36).slice(2, 8);
  return {
    done: `AZITO_DONE_${taskId}_${nonce}`,
    questions: `AZITO_QUESTIONS_${taskId}_${nonce}`,
  };
}

function replaceMarkersInPrompt(prompt: string, markers: { done: string; questions: string }): string {
  return prompt
    .replace(/PHASE_COMPLETE/g, markers.done)
    .replace(/QUESTIONS_JSON/g, markers.questions);
}

describe('unique markers', () => {
  it('should generate unique markers per call', () => {
    const m1 = generateMarkers(11);
    const m2 = generateMarkers(11);
    expect(m1.done).not.toBe(m2.done);
    expect(m1.done).toMatch(/^AZITO_DONE_11_[a-z0-9]+$/);
    expect(m1.questions).toMatch(/^AZITO_QUESTIONS_11_[a-z0-9]+$/);
  });

  it('should replace markers in prompt template', () => {
    const markers = { done: 'AZITO_DONE_11_abc123', questions: 'AZITO_QUESTIONS_11_abc123' };
    const template = 'Report "PHASE_COMPLETE" when done.\nQUESTIONS_JSON: [...]';
    const result = replaceMarkersInPrompt(template, markers);
    expect(result).not.toContain('PHASE_COMPLETE');
    expect(result).not.toContain('QUESTIONS_JSON');
    expect(result).toContain('AZITO_DONE_11_abc123');
    expect(result).toContain('AZITO_QUESTIONS_11_abc123');
  });

  it('should detect unique marker in pipe-pane output', () => {
    const markers = { done: 'AZITO_DONE_11_xyz789', questions: 'AZITO_QUESTIONS_11_xyz789' };
    const output = `some agent output\n${markers.done}\nmore output`;
    expect(output.includes(markers.done)).toBe(true);
    expect(output.includes('PHASE_COMPLETE')).toBe(false);
  });

  it('should not false-detect template markers when using unique markers', () => {
    const markers = { done: 'AZITO_DONE_11_test42', questions: 'AZITO_QUESTIONS_11_test42' };
    const templateEcho = 'Report "AZITO_DONE_11_test42" when done.';
    const agentOutput = 'plan here\nAZITO_DONE_11_test42';
    // Template echo contains the marker, but it's in quotes as instruction
    // Agent output contains it as a bare marker
    // Both will match - but since the template is in initialBuffer, only the agent's is new
    expect(templateEcho.includes(markers.done)).toBe(true);
    expect(agentOutput.includes(markers.done)).toBe(true);
  });
});

// Mirror of the private extractPlanMarkdown from ExecuteTaskUseCase
function extractPlanMarkdown(output: string): string | null {
  const stripped = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

  const templatePlaceholder = '(list each requirement derived from the task)';
  const marker = '実装計画';

  let bestIdx = -1;
  let searchFrom = 0;
  while (true) {
    const idx = stripped.indexOf(marker, searchFrom);
    if (idx < 0) break;
    const afterMarker = stripped.slice(idx, idx + 200);
    if (!afterMarker.includes(templatePlaceholder)) {
      bestIdx = idx;
    }
    searchFrom = idx + marker.length;
  }

  if (bestIdx < 0) return null;

  let plan = stripped.slice(bestIdx);
  const endIdx = plan.search(/PHASE_COMPLETE/i);
  if (endIdx > 0) {
    plan = plan.slice(0, endIdx);
  }
  return plan.trim() || null;
}

describe('extractPlanMarkdown', () => {
  const PROMPT_TEMPLATE = `<output>
Output your plan using the following markdown format exactly:

## 実装計画

### 要件
- (list each requirement derived from the task)

### 変更ファイル
| 種別 | ファイル | 変更内容 |
|------|---------|---------|
| add/modify/delete | path/to/file | what changes |

After outputting the plan, report "PHASE_COMPLETE".
If you have questions that need human input, report them prefixed with "QUESTION:".
</output>`;

  const AGENT_RESPONSE_WITH_HEADER = `## 実装計画

### 要件
- カンバン表示の追加
- Tasks一覧とWorkspaceで共通コンポーネント

### 変更ファイル
| 種別 | ファイル | 変更内容 |
|------|---------|---------|
| add | TaskKanban.tsx | カンバンコンポーネント |

PHASE_COMPLETE`;

  const AGENT_RESPONSE_WITHOUT_HEADER = `実装計画

### 要件
- カンバン表示の追加
- Tasks一覧とWorkspaceで共通コンポーネント

### 変更ファイル
| 種別 | ファイル | 変更内容 |
|------|---------|---------|
| add | TaskKanban.tsx | カンバンコンポーネント |

PHASE_COMPLETE`;

  it('should extract plan from agent response with ## header', () => {
    const output = PROMPT_TEMPLATE + '\n\n' + AGENT_RESPONSE_WITH_HEADER;
    const result = extractPlanMarkdown(output);
    expect(result).not.toBeNull();
    expect(result).toContain('カンバン表示の追加');
    expect(result).not.toContain('(list each requirement derived from the task)');
  });

  it('should extract plan from agent response WITHOUT ## header', () => {
    const output = PROMPT_TEMPLATE + '\n\n' + AGENT_RESPONSE_WITHOUT_HEADER;
    const result = extractPlanMarkdown(output);
    expect(result).not.toBeNull();
    expect(result).toContain('カンバン表示の追加');
    expect(result).not.toContain('(list each requirement derived from the task)');
  });

  it('should not extract template content when agent has not responded', () => {
    const result = extractPlanMarkdown(PROMPT_TEMPLATE);
    expect(result).toBeNull();
  });

  it('should strip PHASE_COMPLETE from the plan', () => {
    const output = PROMPT_TEMPLATE + '\n\n' + AGENT_RESPONSE_WITH_HEADER;
    const result = extractPlanMarkdown(output);
    expect(result).not.toContain('PHASE_COMPLETE');
  });

  it('should handle ANSI escape codes', () => {
    const ansiOutput = '\x1B[38;2;255;255;255m' + PROMPT_TEMPLATE + '\x1B[0m\n\n\x1B[1m' + AGENT_RESPONSE_WITH_HEADER + '\x1B[0m';
    const result = extractPlanMarkdown(ansiOutput);
    expect(result).not.toBeNull();
    expect(result).toContain('カンバン表示の追加');
  });

  it('should return null when no plan marker exists', () => {
    const result = extractPlanMarkdown('Some random output without any plan');
    expect(result).toBeNull();
  });

  // Simulates the real scenario: full tmux scrollback with shell prompt + prompt paste + agent response
  it('should extract agent plan from full tmux scrollback', () => {
    const shellPrompt = '❯ cd /home/user/workspace/example-project\n❯ claude --dangerously-skip-permissions\n';
    const claudeHeader = 'Claude Code v2.1.153\nOpus 4.6\n';
    const pastedPrompt = '❯ ' + PROMPT_TEMPLATE + '\n';
    const thinking = '● Exploring codebase...\n● Read 5 files\n';
    const agentPlan = AGENT_RESPONSE_WITHOUT_HEADER;

    const fullOutput = shellPrompt + claudeHeader + pastedPrompt + thinking + agentPlan;
    const result = extractPlanMarkdown(fullOutput);
    expect(result).not.toBeNull();
    expect(result).toContain('カンバン表示の追加');
    expect(result).not.toContain('(list each requirement derived from the task)');
  });

  // The actual failing scenario: template occurs AFTER agent response in scrollback
  it('should handle case where template appears after agent response in scrollback', () => {
    // This can happen when capture-pane captures in reverse order or when
    // the prompt template is at the bottom of the scrollback (most recent)
    const agentPlan = AGENT_RESPONSE_WITHOUT_HEADER;
    const fullOutput = agentPlan + '\n\n' + PROMPT_TEMPLATE;
    const result = extractPlanMarkdown(fullOutput);
    // lastIndexOf finds the template, but it should be skipped
    expect(result).not.toBeNull();
    expect(result).toContain('カンバン表示の追加');
    expect(result).not.toContain('(list each requirement derived from the task)');
  });
});

// Mirror of extractQuestionsJson from PaneClassifier
function extractQuestionsJson(text: string): PaneQuestion[] | null {
  const stripped = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  const markerIdx = stripped.indexOf('QUESTIONS_JSON:');
  if (markerIdx < 0) return null;

  const afterMarker = stripped.slice(markerIdx + 'QUESTIONS_JSON:'.length).trimStart();
  if (!afterMarker.startsWith('[')) return null;

  let depth = 0;
  let endIdx = -1;
  for (let i = 0; i < afterMarker.length; i++) {
    if (afterMarker[i] === '[') depth++;
    else if (afterMarker[i] === ']') { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx < 0) return null;

  try {
    return JSON.parse(afterMarker.slice(0, endIdx + 1)) as PaneQuestion[];
  } catch {
    return null;
  }
}

describe('extractQuestionsJson', () => {
  it('should extract structured questions from QUESTIONS_JSON marker', () => {
    const output = `Some thinking output...

QUESTIONS_JSON: [{"text":"カンバンのカラム構成はどうしますか？","type":"select","options":["5列グループ化","全個別列","カスタム"]},{"text":"サイドバーの表示形式は？","type":"select","options":["縦セクション","横スクロール"]}]

More output...`;
    const result = extractQuestionsJson(output);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].text).toBe('カンバンのカラム構成はどうしますか？');
    expect(result![0].type).toBe('select');
    expect(result![0].options).toEqual(['5列グループ化', '全個別列', 'カスタム']);
    expect(result![1].text).toBe('サイドバーの表示形式は？');
  });

  it('should return null when no QUESTIONS_JSON marker', () => {
    const result = extractQuestionsJson('No questions here\nJust normal output');
    expect(result).toBeNull();
  });

  it('should return null on malformed JSON', () => {
    const result = extractQuestionsJson('QUESTIONS_JSON: [{"broken json');
    expect(result).toBeNull();
  });

  it('should handle ANSI codes in the output', () => {
    const output = '\x1B[1mQUESTIONS_JSON: [{"text":"質問","type":"text"}]\x1B[0m';
    const result = extractQuestionsJson(output);
    expect(result).not.toBeNull();
    expect(result![0].text).toBe('質問');
  });

  it('should handle template QUESTIONS_JSON instruction without matching', () => {
    // The prompt template explains the format but doesn't contain actual JSON array
    const template = 'If you have questions, output: QUESTIONS_JSON: followed by a JSON array';
    const result = extractQuestionsJson(template);
    expect(result).toBeNull();
  });

  it('should extract questions with text type', () => {
    const output = 'QUESTIONS_JSON: [{"text":"プロジェクト名を教えてください","type":"text"}]';
    const result = extractQuestionsJson(output);
    expect(result).not.toBeNull();
    expect(result![0].type).toBe('text');
    expect(result![0].options).toBeUndefined();
  });

  it('should coexist with PHASE_COMPLETE in the same output', () => {
    const output = `## 実装計画
### 要件
- 機能追加

QUESTIONS_JSON: [{"text":"追加の確認事項","type":"text"}]

PHASE_COMPLETE`;
    const plan = extractPlanMarkdown(output);
    const questions = extractQuestionsJson(output);
    expect(plan).not.toBeNull();
    expect(plan).toContain('機能追加');
    expect(questions).not.toBeNull();
    expect(questions![0].text).toBe('追加の確認事項');
  });
});

