---
name: implementing-default
description: 計画に従って実装する
tags: implementing
isDefault: true
---
<task>
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
The implemented code, ready for review.
</output>

{{module.uiDesignPrinciples}}

{{module.softwareDesignPrinciples}}