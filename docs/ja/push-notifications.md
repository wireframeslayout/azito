# プッシュ通知セットアップガイド

Tailscale を使った PWA プッシュ通知の有効化手順です。タスクの完了・失敗時にブラウザやモバイル端末へ通知を受け取れます。

## 前提条件

- Tailscale がインストール済みで tailnet に接続されていること
- AZITO バックエンドサーバーが起動中（デフォルトポート 3001）
- Vite 開発サーバーが起動中（デフォルトポート 5173）

## ステップ 1: Tailscale Serve の有効化

Tailscale Serve を使い、ローカルの Vite 開発サーバーを HTTPS でプロキシします。

```bash
# sudo なしで serve を管理できるようにする（初回のみ）
sudo tailscale set --operator=$USER

# HTTPS プロキシを開始
tailscale serve --bg http://localhost:5173
```

これにより `https://<マシン名>.tail<xxxxx>.ts.net` で HTTPS アクセスが可能になります。

## ステップ 2: Vite の設定（設定済み）

`vite.config.ts` の `server` 設定に `allowedHosts: true` が必要ですが、AZITO ではすでに設定済みです。

```typescript
// packages/frontend/vite.config.ts
export default defineConfig({
  server: {
    port: 5173,
    allowedHosts: true,  // Tailscale ホスト名を許可
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
})
```

## ステップ 3: HTTPS でアクセス

ブラウザで Tailscale の HTTPS URL を開きます。

```
https://<マシン名>.tail<xxxxx>.ts.net
```

マシン名は `tailscale status` コマンドで確認できます。

## ステップ 4: 通知を購読

1. 左上のナビゲーションから **Settings** を開く
2. サイドバーで **Notifications** を選択
3. **Subscribe** ボタンをクリック
4. ブラウザの通知許可ダイアログで「許可」を選択

購読が完了すると、ステータスが「Subscribed - you will receive notifications」に変わります。

## ステップ 5: テスト

テスト通知を送信して動作を確認します。

```bash
curl -X POST http://localhost:3001/api/notifications/test
```

ブラウザ通知が表示されれば設定完了です。

## モバイル端末での設定

### iOS

iOS 16.4 以降が必要です。

1. Safari で `https://<マシン名>.tail<xxxxx>.ts.net` を開く
2. 共有ボタン（四角に上矢印のアイコン）をタップ
3. 「ホーム画面に追加」を選択
4. ホーム画面に追加された AZITO アイコンからアプリを開く
5. Settings > Notifications > Subscribe をタップ

**注意:** Safari のタブからではなく、必ずホーム画面に追加したアプリアイコンから開いてください。Safari のタブでは PWA プッシュ通知は動作しません。

### Android

1. Chrome で `https://<マシン名>.tail<xxxxx>.ts.net` を開く
2. PWA インストールプロンプトが表示されたら「インストール」をタップ（表示されない場合はメニューから「ホーム画面に追加」）
3. Settings > Notifications > Subscribe をタップ

## 通知トリガー

以下のイベント発生時にプッシュ通知が送信されます:

- タスクが正常に完了した（done）
- タスクがエラーで失敗した（error / send_error / codex_error）
- タスクがユーザーにより停止された（stopped_by_user）
- タスクが質問を生成した（waiting_for_human）
- タスクのフェーズ成果物がレビュー待ちになった（phase_review）
- エージェントの処理が完了した（Agent Finished -- 稼働検知ベース）
- エージェントが承認待ちになった（Approval Required -- 稼働検知ベース）

タスクステータス起因の通知（done / error 系 / stopped_by_user / waiting_for_human / phase_review）は、タスクのステータス変化を購読して送信されます。「Agent Finished」「Approval Required」はタスクの有無に関わらず、`AgentActivityMonitor` によるエージェントの稼働検知（running→idle、working→blocked の遷移）から送信されます。

なお、以前は Claude Code の hook（`azito-notify.sh`）経由でプッシュ通知を送信していましたが、現在は上記の稼働検知ベースの通知に置き換わっています。hook のエンドポイント（`/api/webhooks/agent-done`）自体は後方互換のため存続していますが、プッシュ通知は送信しません。

## トラブルシューティング

### 「Not supported」と表示される

HTTPS でアクセスする必要があります。`http://` や IP アドレスでのアクセスではプッシュ通知は利用できません。Tailscale Serve で HTTPS URL を使用してください。

### 購読済みだが通知が来ない

- OS のブラウザ通知設定を確認してください（OS の設定 > 通知 > ブラウザ名）
- ブラウザの通知権限が「許可」になっているか確認してください
- バックエンドサーバーが起動しているか確認してください

### iOS で通知が来ない

- iOS 16.4 以降を使用しているか確認してください
- Safari のタブではなく、ホーム画面に追加したアプリアイコンから開いているか確認してください
- iOS の設定 > 通知 で AZITO の通知が許可されているか確認してください

### 購読解除したい

Settings > Notifications で「Unsubscribe」ボタンをクリックしてください。
