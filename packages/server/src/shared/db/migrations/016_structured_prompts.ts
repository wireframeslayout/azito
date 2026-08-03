import type { Database } from 'better-sqlite3';

export const version = 16;
export const description = 'Add plan_markdown column and update phase prompts with structured format';

export function up(db: Database): void {
  // ─── Add plan_markdown column to tasks ───
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN plan_markdown TEXT');
  } catch {
    // column may already exist
  }

  // ─── Update phase prompts with structured format ───
  const updatePhase = db.prepare(
    "UPDATE phase_prompts SET prompt = ?, updated_at = datetime('now') WHERE phase = ?",
  );

  updatePhase.run(`<task>
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
If you have questions that need human input, report them prefixed with "QUESTION:".
</output>`, 'planning');

  updatePhase.run(`<task>
Implement according to the plan.
Title: {{task.title}}
Working directory: {{projectServer.workingDirectory}}
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
If you have questions that need human input, report them prefixed with "QUESTION:".
</output>`, 'implementing');

  updatePhase.run(`<task>
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
</output>`, 'reviewing');

  updatePhase.run(`<task>
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
</output>`, 'testing');

  updatePhase.run(`<task>
Push the implementation and create a Pull Request.
</task>

<rules>
- Base branch: {{project.defaultBranch}}
- PR title should concisely describe the task
- PR body should include a summary of changes and test results

{{project.sidekickPrompt}}
</rules>

<output>
Report the PR URL.
Report "PHASE_COMPLETE" when done.
</output>`, 'pushing');
}
