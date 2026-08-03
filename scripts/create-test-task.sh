#!/usr/bin/env bash
# Create a test task for verifying the State Machine flow (planning → implementing → reviewing → testing → pushing)
#
# Usage:
#   ./scripts/create-test-task.sh <project_id> <unit_id> [PORT]
#
# Example:
#   ./scripts/create-test-task.sh 4 5
#   ./scripts/create-test-task.sh 4 5 3001

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <project_id> <unit_id> [PORT]"
  echo "Example: $0 4 5"
  exit 1
fi

PROJECT_ID="$1"
UNIT_ID="$2"
PORT="${3:-3001}"

node -e "
const http = require('http');

const projectId = ${PROJECT_ID};
const unitId = ${UNIT_ID};
const port = ${PORT};

const body = JSON.stringify({
  project_id: projectId,
  unit_id: unitId,
  title: '[TEST] State Machine フロー検証',
  description: \`このタスクは、State Machineモードが正しく動作するかを確認するためのテストタスクです。
最後のレビューまで止まることなくState Machineが動作するかをテストします。

あなたは、プロンプトの指示が来たら以下のようにふるまってください。
このタスクが張り付けられた後、"指示通り"に作業を行ってください。
以下のことに留意して作業をお願いします。
- 適当な質問を指定されているJSON形式で投稿してください。
- 極小の修正として タスクの作成モーダルのタイトル Edit Task を Edit Task. と . を追加するだけの実装計画およびコミットを作成してください。
- 作成するプルリクエストのタイトルに TEST: という文字列と、内容に「マージ不要」と記載してください。\`,
  require_plan_approval: true,
});

const req = http.request({ hostname: 'localhost', port, path: '/api/tasks', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
  let data = '';
  res.on('data', (c) => data += c);
  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      if (result.id) {
        console.log('✓ Test task created: id=' + result.id + ' project=' + projectId + ' unit=' + unitId);
        console.log('  Execute from UI or:');
        console.log('  curl -X POST http://localhost:' + port + '/api/units/' + unitId + '/execute -H \"Content-Type: application/json\" -d \'{\"taskId\":' + result.id + '}\"');
      } else {
        console.error('Error:', data);
        process.exit(1);
      }
    } catch { console.error('Error:', data); process.exit(1); }
  });
});
req.on('error', (e) => { console.error('Error:', e.message); process.exit(1); });
req.write(body);
req.end();
"
