---
name: planning-default
description: タスクを分析し実装計画を作成する
tags: planning
isDefault: true
---
<task>
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
</output>

{{module.softwareDesignPrinciples}}

{{module.uiDesignPrinciples}}