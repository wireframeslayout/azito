import type Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export const version = 39;
export const description = 'Export user-edited phase_prompts rows to the user sidekick layer (Issue #263 Phase 4)';

/**
 * 期待される seed 最終形（migration 001→038 を新規DBに適用した直後の phase_prompts.prompt と同一。
 * harness/sidekicks/<phase>-default/SKILL.md の本文と一致させてある — ビルトインパッケージの内容）。
 * 一致すればビルトインパッケージがそのまま引き継ぐので、このマイグレーションは何もしない。
 * 不一致（ユーザーが phase_prompts を編集していた）場合のみ、ユーザー層へ書き出す。
 */
const EXPECTED_SEED: Record<string, string> = {
  planning: `<task>
Analyze the task and create an implementation plan.
Title: {{task.title}}
Details: {{task.description}}
</task>

<rules>
{{project.sidekickPrompt}}
</rules>

<output>
Output your plan using the following markdown format exactly:

## 実装計画

### 要件
- (list each requirement derived from the task)

### 変更ファイル
| 種別 | ファイル | 変更内容 |
|------|---------|---------|
| add/modify/delete | path/to/file | what changes |

### 実装ステップ
1. (numbered implementation steps)

### 影響範囲
- (affected modules, features, or endpoints)

### 設計判断（あれば）
- (design decisions with rationale)

### リスク
- (potential risks or concerns)

After outputting the plan, report "PHASE_COMPLETE".
If you have questions that need human input, output them as structured JSON on a single line:
QUESTIONS_JSON: [{"text":"question text","type":"select","options":["option1","option2"]},{"text":"open question","type":"text"}]
- Use "select" type when you can enumerate the choices, and "text" type for open-ended questions.
- Output ALL questions at once in a single QUESTIONS_JSON line.
- Do NOT use interactive prompts or selection UIs. Output QUESTIONS_JSON and then stop.
</output>

{{module.softwareDesignPrinciples}}

{{module.uiDesignPrinciples}}`,
  implementing: `<task>
Implement according to the plan.
Title: {{task.title}}
Working directory: {{projectServer.workingDirectory}}

<plan>
{{task.plan}}
</plan>
</task>

<rules>
{{project.sidekickPrompt}}

If this is a git repository:
- Create a working branch from {{project.defaultBranch}}
- Name the branch based on the task content
- Commit frequently with clear messages
</rules>

<self-check>
Before reporting completion, verify:
- 計画にない変更を含めていないか（スコープクリープ）
- フォールバックで必須データの欠損を隠していないか
- 新パラメータの呼び出し経路は確保されているか（配線忘れ）
- デッドコード（未使用の関数・型・インポート）が残っていないか
</self-check>

<output>
Report "PHASE_COMPLETE" when implementation is done.
If you have questions that need human input, output them as structured JSON on a single line:
QUESTIONS_JSON: [{"text":"question text","type":"select","options":["option1","option2"]},{"text":"open question","type":"text"}]
- Use "select" type when you can enumerate the choices, and "text" type for open-ended questions.
- Output ALL questions at once in a single QUESTIONS_JSON line.
- Do NOT use interactive prompts or selection UIs. Output QUESTIONS_JSON and then stop.
</output>

{{module.uiDesignPrinciples}}

{{module.softwareDesignPrinciples}}`,
  reviewing: `<task>
Review your own implementation. (Attempt {{selfReview.attempt}}/{{selfReview.maxAttempts}})
</task>

<rules>
Review the diff against these criteria:

| 観点 | 確認内容 |
|---|---|
| 設計 | 責務分離、依存方向、抽象度の一貫性 |
| 正確性 | ロジック誤り、境界値、エラーハンドリング |
| AIアンチパターン | フォールバック濫用、デッドコード、配線忘れ |
| テスト | 新機能のテスト有無、エッジケースのカバー |

Additional rules:
{{project.sidekickPrompt}}
</rules>

<output>
Fix any problems you find directly in the code.
Report "PHASE_COMPLETE" if everything looks good.
</output>

{{module.reviewPerspectives}}`,
  testing: `<task>
Run tests for the implemented code.
</task>

<rules>
- Verify existing tests are not broken
- Run the test suite if available
- Run type checking (tsc --noEmit, etc.) if available
- Add new tests if needed for new functionality

{{project.sidekickPrompt}}
</rules>

<output>
Report test results.
Report "PHASE_COMPLETE" if all tests pass.
If tests fail, report the failures prefixed with "TEST_FAILED:".
</output>`,
  pushing: `<task>
{{task.pushTaskDescription}}
</task>

<rules>
- Base branch: {{project.defaultBranch}}
{{task.targetBranch}}
{{task.pushRules}}

{{project.sidekickPrompt}}
</rules>

<output>
{{task.pushOutput}}
Report "PHASE_COMPLETE" when done.
</output>`,
};

// packages/server/src/shared/db/migrations → migrations → db → shared → src → server → packages → repo root
const USER_SIDEKICKS_DIR = process.env.AZITO_SIDEKICKS_DIR
  ? path.resolve(process.env.AZITO_SIDEKICKS_DIR)
  : path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'data', 'sidekicks');

/**
 * enabled=false の扱い: フェーズの有効/無効はパッケージの責務外（Phase 5 で Operation 側に持たせる）。
 * ここでは本文が seed と一致するかどうかだけを見て編集検出を行い、enabled の値は無視する
 * （enabled=false だからといって編集検出の対象から除外はしない）。
 */
export function up(db: Database.Database): void {
  const rows = db.prepare('SELECT phase, prompt FROM phase_prompts').all() as Array<{ phase: string; prompt: string }>;

  for (const row of rows) {
    const expected = EXPECTED_SEED[row.phase];
    if (expected === undefined) continue; // 未知の phase は対象外（防御的スキップ）
    if (row.prompt === expected) continue; // 未編集: ビルトインパッケージがそのまま引き継ぐ

    const pkgDir = path.join(USER_SIDEKICKS_DIR, `${row.phase}-default`);
    const skillPath = path.join(pkgDir, 'SKILL.md');

    if (fs.existsSync(skillPath)) {
      console.warn(`[migration 039] ${skillPath} already exists; not overwriting.`);
      continue;
    }

    fs.mkdirSync(pkgDir, { recursive: true });
    const content = `---
name: ${row.phase}-default
description: Exported from user-edited phase_prompts (migration 039)
phase: ${row.phase}
isDefault: true
---
${row.prompt}`;
    fs.writeFileSync(skillPath, content, 'utf-8');
    console.log(`[migration 039] Exported edited phase_prompts.${row.phase} to ${skillPath}`);
  }
}
