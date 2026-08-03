# GitHub / GitLab 連携ガイド

AZITO はプロジェクトに GitHub / GitLab リポジトリを紐づけ、イシューの閲覧・検索・タスクへの変換を行えます。セルフホストの GitLab にも対応しています。

## リポジトリの追加

### ワークスペースのサイドバーから追加

1. ワークスペースのアクティビティバーで **Repositories** モードを選択
2. 「+」ボタンをクリック
3. 以下の情報を入力する

| 項目 | 説明 |
|---|---|
| Provider | `GitHub` または `GitLab` を選択 |
| Repository URL | リポジトリの URL（例: `https://github.com/owner/repo`） |
| Owner | リポジトリのオーナー名（URL から自動入力） |
| Repo | リポジトリ名（URL から自動入力） |
| Name | 表示名（省略可。省略時は `owner/repo` が表示される） |
| Token | アクセストークン（省略可。後述の認証方法を参照） |

4. **Add** ボタンをクリック

### Settings から追加

ワークスペースの Settings モードの Repositories セクションからも同様に追加できます。

## 認証

AZITO は以下の優先順位でトークンを解決します。

### GitHub

1. **リポジトリごとのトークン** -- リポジトリ追加時に Token フィールドに入力した個人アクセストークン（PAT）
2. **gh CLI トークン** -- サーバー上で `gh auth login` 済みの場合、`gh auth token` コマンドからトークンを自動取得。GitHub Enterprise Server（後述）の場合は `gh auth token --hostname <host>` でホストごとのトークンを取得

gh CLI での認証が推奨です。

```bash
# GitHub CLI でログイン（初回のみ）
gh auth login
```

### GitLab

1. **リポジトリごとのトークン** -- リポジトリ追加時に Token フィールドに入力した個人アクセストークン
2. **glab CLI トークン** -- サーバー上で `glab auth login` 済みの場合、`glab config get token -h <host>` コマンドからトークンを自動取得

```bash
# GitLab CLI でログイン（初回のみ）
glab auth login
```

### 手動でのトークン設定

CLI を使用しない場合は、リポジトリ追加時に Token フィールドにトークンを直接入力します。

- **GitHub**: Settings > Developer settings > Personal access tokens で `repo` スコープ付きのトークンを生成
- **GitLab**: Settings > Access Tokens で `read_api` スコープ付きのトークンを生成

## イシューの閲覧

1. ワークスペースのサイドバーで **Repositories** モードを選択
2. リポジトリをクリックして選択
3. メインエリアにイシュー一覧が表示される

イシュー一覧では以下の操作が可能です:

- **ステータスフィルター** -- Open / Closed / All でフィルタリング
- **ページネーション** -- 「Load more」ボタンで追加読み込み（1ページ20件）
- **イシュー詳細** -- イシューをクリックするとタブで詳細を表示
- **外部リンク** -- イシューの GitHub / GitLab ページを新しいタブで開く

## イシューの検索

イシュー一覧の上部にある検索フィールドにキーワードを入力し、Enter キーまたは検索ボタンで検索を実行します。

- GitHub: タイトルと本文を対象に検索
- GitLab: タイトルと説明を対象に検索

検索をクリアすると、通常のイシュー一覧に戻ります。

## プルリクエスト / マージリクエスト

リポジトリのプルリクエスト（GitHub）/ マージリクエスト（GitLab）を閲覧できます。

### タブの切り替え

リポジトリを選択すると、メインエリアの上部に **Issues** / **Pull Requests** のタブが表示されます。タブをクリックして表示を切り替えます（GitLab の場合は「Merge Requests」と表示されます）。

### プルリクエスト一覧

Pull Requests タブでは、リポジトリのプルリクエストが一覧表示されます。

- **ステータスバッジ** -- PR の状態に応じて色分けされたバッジが表示されます
  - **Open** -- 緑色（レビュー待ち・作業中）
  - **Merged** -- 紫色（マージ済み）
  - **Closed** -- 赤色（クローズ済み）
  - **Draft** -- グレー（ドラフト・作業中）
- **ブランチ情報** -- `head → base`（例: `feature/login → main`）の形式でブランチ名が表示されます
- **外部リンク** -- PR をクリックすると GitHub / GitLab のページが新しいタブで開きます
- **ページネーション** -- 「Load more」ボタンで追加読み込み（1ページ20件）
- **ステータスフィルター** -- Open / Closed / Merged / All でフィルタリング可能

## PR/MR の自動作成

タスクの pushing フェーズでは、`PullRequestCreator` により PR/MR がサーバーサイドで自動作成されます。

- `gh` CLI や `glab` CLI が利用できない環境（リモートワーカーなど）でも、GitHub/GitLab API 経由で PR/MR を作成できます
- 作成前に同一ブランチの既存 PR/MR を検出し、既にある場合は作成をスキップします（重複作成の防止）
- ベストエフォスト方式で動作します。作成に失敗しても（権限不足・プロバイダー障害・リポジトリ未設定など）ログに記録されるのみで、プッシュ完了自体はブロックされません
- GitHub Enterprise Server（GHE、セルフホスト GitHub）にも対応しています。リポジトリ URL のホスト名から `<origin>/api/v3` エンドポイントを自動検出して使用します

## イシューからタスクの作成

### イシュー一覧から

イシュー一覧の各イシューの右側にある「Import」ボタンをクリックすると、タスク作成フォームにイシューのタイトルと本文が自動入力されます。

### タスク作成モーダルから

1. ワークスペースのサイドバーで **Tasks** モードを選択
2. 「+」ボタンでタスク作成モーダルを開く
3. 「Import from Issue」ボタンをクリック
4. リポジトリを選択してイシューを検索
5. イシューを選択するとタイトルと説明が自動入力

インポートされたタスクにはソース情報（例: `owner/repo#123`）が記録されます。

## GitLab 対応

### gitlab.com

Provider で「GitLab」を選択し、`https://gitlab.com/owner/repo` 形式の URL を入力します。

### セルフホスト GitLab

セルフホストの GitLab にも対応しています。

1. Provider で「GitLab」を選択
2. Repository URL にセルフホスト GitLab の URL を入力（例: `https://gitlab.example.com/group/subgroup/repo`）
3. Owner にはグループ / サブグループパスを、Repo にはリポジトリ名を入力
4. Token にアクセストークンを入力（または `glab auth login -h gitlab.example.com` で CLI 認証）

AZITO はリポジトリ URL からホスト名を自動判別し、適切な API エンドポイントを使用します。

## トラブルシューティング

### イシューが表示されない

- トークンが正しく設定されているか確認してください
- `gh auth status`（GitHub）または `glab auth status`（GitLab）でCLI の認証状態を確認してください
- Owner と Repo が正しいか確認してください

### 「Repository owner and name required」エラー

リポジトリの Owner または Repo フィールドが空です。リポジトリの設定を確認し、URL を再入力してください。URL 入力時に Owner と Repo は自動入力されます。

### セルフホスト GitLab に接続できない

- GitLab の URL が正しいか確認してください
- トークンに `read_api` スコープが付与されているか確認してください
- AZITO サーバーから GitLab サーバーへの接続が可能か確認してください
