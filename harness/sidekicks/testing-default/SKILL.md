---
name: testing-default
description: 実装したコードのテストを実行する
tags: testing
isDefault: true
---
<task>
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
The test results: which tests ran, and whether they passed.
</output>