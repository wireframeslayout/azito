---
name: reviewing-default
description: 自身の実装をレビューし問題を修正する
tags: reviewing
isDefault: true
---
<task>
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
</output>

{{module.reviewPerspectives}}