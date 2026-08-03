# design-sync NOTES — AZITO (@azito/frontend)

- 2026-07-30 再同期: 前回同期（2026-07-06、20コンポーネント）のローカル状態（config / authored previews）は
  失われていた。リモート「AZITO Design System」(f6287ee3-9fa6-423b-a9cb-78aa7b96290a) から README と
  `_ds_sync.json` を取得して設定を復元。globalName は `Azito`。
- ソース形状: package（Storybook なし）。`@azito/frontend` はアプリでありライブラリビルド（dist/）を持たない →
  synth-entry モードで `src/` から合成。`node_modules/@azito/frontend` はワークスペースの symlink として解決される。
- CSS は `packages/frontend/src/styles/global.css` の1ファイル（トークン + ユーティリティクラス）。ダークテーマのみ。
- 除外（componentSrcMap: null）: `App` / `Layout` / `TokenGate` / 各種 `*Provider` / pages（Workspace, Units,
  Sidekicks）— アプリ配線でありデザイン部品ではない。
- 画面級コンポーネント（workspace/ の Panel 群、servers/ 等）はデータ・フック依存が強く、authored preview の
  対象外（フロアカード運用）。プレゼンテーショナルな ui/ 系にリッチプレビューを作成する。
- playwright: リポジトリの playwright-core 1.61.1 が chromium-1228（キャッシュ済み）と一致。`.ds-sync/` にも
  playwright@1.61.1 を導入して validate のレンダーチェックに使用。
- **重要**: `srcDir` は必ず `src/components` にする。デフォルト（`src/`）だと synth entry が `src/main.tsx`
  （`createRoot` 副作用を持つ Vite アプリエントリ）まで含め、バンドル評価時に例外
  （"Target container is not a DOM element"）が出て `[BUNDLE_EXPORT]` 152/152 失敗になる。
- **default export のみのコンポーネント（83件: Modal, FormField, MarkdownRenderer, AzitoLogo 等）は
  `export *` の synth entry では `window.Azito` に載らない** → `.design-sync/default-exports-entry.ts`
  （`export { default as Name } from ...` を列挙した生成ファイル）を `extraEntries` で合流させて解決。
  コンポーネントを追加/削除したら、この再エクスポートファイルも再生成が必要（生成コマンドは git log 参照）。
  extraEntries のパスは PKG_DIR（node_modules/@azito/frontend symlink）起点の相対解決なので `../../../` が正しい。
  `[EXPORT_COLLISION]` 警告は名前ベースの過剰検出で実害なし（main 側は default を落とすため実際は衝突しない）。
- バンドルはモジュールスコープで localStorage を読む（テーマ永続化）。about:blank や data: URL 上で
  `<script>` 評価すると SecurityError で IIFE 全体が死ぬ。http origin 上で読み込めば問題ない。
- Modal / ContextMenu / BottomSheet 等は `position: fixed` でカード外に逃げる → validate の
  `[GRID_OVERFLOW]` が提案する `cardMode` オーバーライドを config に反映する。

## プレビュー作成の学び（Wave 1 統合、2026-07-30）

- **fixed オーバーレイの封じ込め**: `transform: 'translateZ(0)'`（または translate(0,0)）＋
  `position: relative` ＋明示的な高さ ＋ `overflow: hidden` のラッパで `position: fixed` が
  ラッパ基準になり、Modal/GlassPopover/BottomSheet/ConfirmDialog がカード内に収まる。
  cardMode/viewport オーバーライドは不要（config の Modal/ContextMenu overrides は保険として残す）。
  GlassPopover はラッパ高さ ≥300px（bottom: 76px アンカーのため）。
- **CommitList / DiffViewer はフロアカード**（マウント時 API フェッチのみ、props でデータを渡せない）。
  リッチプレビューが欲しければ props 注入シームの追加が必要（アプリ側変更）。
- SubagentConfigCard のマウント時 `/agents` フェッチはキャプチャ環境で失敗するが描画は完全
  （console エラーは良性）。StatusDropdown にフェッチはない。
- `height: 100%` ルートのコンポーネント（DiffFileList, DiffContent, FormPage, PageContainer）は
  プレビュー側で固定高さラッパが必要。
- ActiveWindowDot は position:absolute（親に position:relative 必須）。BlockedDot は global.css
  （.aw-blocked-dot）依存。BrailleSpinner は静的キャプチャで最初のフレーム ⠋ が写る。
- MetricRow は statusbar/ResourceDropdown.tsx 由来だがグループは `general`。
- 絵文字はヘッドレスで tofu になるが、✓ ✗ ✳ ⚠ ▶ ▢ … 等の記号グリフは問題なし。
- PixelIcon の有効名は ui/pixel-icons/icons24.ts の ICON_BUILDERS_24 キー。
- PageHeader/PageBody のモバイル分岐（useIsMobile）はキャプチャ未検証（デスクトップ幅のみ）。

## Known render warns（トリアージ済み・良性）

- ListRow/IconButton プレビューの絵文字 tofu（ヘッドレス環境のフォント差、実ブラウザでは正常）
  → 以後のプレビューでは絵文字不使用。
- SubagentConfigCard の [RENDER_ERRORS]（fetch 失敗 console エラー）は良性、描画は完全。
- AppearanceSection は TerminalThemeProvider 必須のためフロアカード（[RENDER_ERRORS] 1件は想定内）。
- UnitFormView はマウント時フェッチによる [RENDER_ERRORS]（良性、画面級・フロアカード）。
- 小型ドット/アイコン系の [RENDER_BLANK]/[RENDER_THIN] は authored preview 導入後に解消済み。
  未 author の画面級コンポーネントに残る同警告はフロアカード相当で良性。

## Re-sync risks（次回同期の注意）

- `.design-sync/default-exports-entry.ts` は生成物（コンポーネント追加/削除で再生成が必要）。
  再生成せず同期すると新しい default export コンポーネントが window.Azito に載らない。
- conventions.md のユーティリティクラス/トークン列挙は global.css の変更で陳腐化し得る
  → 再同期時に検証パスを回す。
- JetBrains Mono はリポジトリ非同梱（[FONT_MISSING] 警告は既知）。扱いはユーザー判断待ち
  （Google Fonts から取得して同梱 or システムフォント代替を受容）。
- CommitList/DiffViewer/画面級コンポーネントのフロアカードは意図的なベースライン。
