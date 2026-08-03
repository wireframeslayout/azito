---
name: browser-ops
description: CDP ブラウザ接続ヘルパーとログイン・ログ衛生規約
tags: browser
---
<overview>
ブラウザ操作の標準手順を提供する。AZITO の open API でタブを開き、Playwright の CDP 接続で
操作し、完了後にグループを閉じるまでの一連の流れと、ログイン方針・ログ衛生規約をまとめている。
ヘルパースクリプト `{{sidekick.dir}}/scripts/browser-connect.mjs` を使うことで、接続・入力・
保存・クローズの定型処理を関数呼び出しで済ませられる。
</overview>

<connection>
## 接続手順

### 1. タブを開く

ローカルサーバーの場合:
```javascript
const res = await fetch(`${process.env.AZITO_URL}/api/browser/open`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ server: '<serverName>', url: 'https://example.com', holdSeconds: 300 }),
});
const { cdpEndpoint, targetId, groupId } = await res.json();
```

agent サーバーの場合:
```javascript
const res = await fetch(`http://127.0.0.1:${process.env.AZITO_AGENT_PORT}/api/browser/open`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'authorization': `Bearer ${process.env.AZITO_AGENT_TOKEN}`,
  },
  body: JSON.stringify({ url: 'https://example.com', holdSeconds: 300 }),
});
const { cdpEndpoint, targetId, groupId } = await res.json();
```

`holdSeconds` はタブの自動クローズまでの猶予時間（秒）。長時間の操作が見込まれる場合は長めに設定する。

### 2. CDP 接続

```javascript
const { chromium } = await import('playwright');
const browser = await chromium.connectOverCDP(cdpEndpoint);
const pages = browser.contexts()[0].pages();
const page = pages.find(p => {
  const target = p.context().browser()?.contexts()[0].pages().indexOf(p);
  return true; // targetId でのマッチングが必要な場合は BrowserPage の _targetId を参照
});
```

### 3. 操作完了後のクローズ

```javascript
await fetch(`${baseUrl}/api/browser/close-group`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ server: '<serverName>', group: groupId }),
});
```

### ヘルパースクリプト

上記の定型処理は `{{sidekick.dir}}/scripts/browser-connect.mjs` にまとめてある。
```javascript
const { openTab, connect, getPage, fillFromEnv, saveToStorage, closeGroup } = await import('{{sidekick.dir}}/scripts/browser-connect.mjs');

const { cdpEndpoint, targetId, groupId } = await openTab('https://example.com');
const browser = await connect(cdpEndpoint);
const page = await getPage(browser, targetId);

// 操作...

await closeGroup(groupId);
```
</connection>

<login-policy>
## ログイン方針

サイトの種別に応じて3段階のログイン方式を使い分ける。

### 自動ログイン（既定）
自社アプリやテスト対象アプリなど、ボット検知の心配がないサイト。
- `AZITO_SECRET_*` 環境変数からユーザー名・パスワードを取得する
- `page.fill()` でフォームに入力し、送信ボタンをクリックする
- ログイン成功を確認してから次の操作に進む

### 試行→エスカレーション
ボット検知が緩い外部サイト。
- まず自動ログインを試行する
- CAPTCHA・MFA・ブロックを検知したら、人間に委任する質問を発行してタスクを `waiting_input` にする
- 人間がログインを完了したら、タスクを再開する

### human-in-the-loop
Google 等、厳格なボット検知を持つサイト。
- 自動ログインは試みない
- `browser:opened` 通知でユーザーにタブを表示し、手動ログインを依頼する
- 質問を発行してタスクを `waiting_input` にし、ログイン完了の回答を待つ
- ユーザーがログイン完了を報告したら操作を続行する
</login-policy>

<log-hygiene>
## ログ衛生規約

### パスワード入力
- パスワードは必ず `page.fill(selector, value)` を使う
- `page.keyboard.type()` や `page.keyboard.pressSequentially()` は使わない
  （keystroke が tmux の観戦画面に平文で表示される）

### 認証情報の参照
- 認証情報は `AZITO_SECRET_*` 環境変数からのみ取得する
- コード内に認証情報をハードコードしない
- 環境変数名をログに出力してもよいが、値は出力しない

### ログ出力
- `console.log` やエージェントの実行ログに認証情報の値を含めない
- デバッグ用に URL を出力する場合、クエリパラメータにトークンが含まれていないか確認する
- スクリーンショット取得時は、パスワードフィールドにフォーカスがない状態で撮る
</log-hygiene>

<asset-capture>
## 画像・成果物の取得

### フルサイズ画像の待機
- サムネイルや placeholder ではなくフルサイズ画像の読み込みを待つ
- `page.waitForLoadState('networkidle')` や画像要素の `complete` プロパティで確認する
- 遅延読み込み（lazy load）の画像は、スクロールしてビューポートに入れてから待機する

### JPEG 完全性検証
- ダウンロードした JPEG ファイルは末尾が EOI マーカー（`0xFF 0xD9`）で終わることを確認する
- 不完全な場合はリトライする

### 成果物の保存
- 成果物は `POST ${AZITO_URL}/api/projects/<projectId>/storage/upload` へアップロードする
- `multipart/form-data` 形式、フィールド名は `file`
- ヘルパー: `saveToStorage(filePath, projectId)` を使用する
</asset-capture>

<known-issues>
## 既知の問題

- **Google `/sorry` ページ**: bot 検知でブロックされた場合は human-in-the-loop に切り替える
- **サムネイル placeholder**: 画像一覧ページで低解像度 placeholder が表示されることがある。個別画像ページに遷移してフル解像度を待つ
- **UA 正規化**: open API 側で Headless Chrome の User-Agent を通常の Chrome に正規化済み。エージェント側での UA 設定は不要
</known-issues>
