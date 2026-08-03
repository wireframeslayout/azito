# UI サーフェス設計方針（Shade）

意匠名は **Shade**（旧称: 霞 / Kasumi）。ボーダーレス・面の梯子で階層を表現するこの意匠と、
線で階層を表現する旧意匠 **Wired**（`packages/frontend` における master 基準の見た目）は、
`data-design="shade" | "wired"`（既定値 `shade`）で切替可能。以降の本文は Shade 側の設計規約を扱う。

対象: `packages/frontend`。テーマドリブンで配色が変わっても UI の階層設計が
破綻しないための、面（surface）とクラスの設計規約。実装の実体は
`src/styles/global.css` 末尾の「Shade v6」レイヤーと `useTerminalTheme.tsx`。

## 1. ソース・オブ・トゥルースは2変数

テーマが UI に注入してよいのは次の2つだけ。

| 変数 | 意味 | 供給元 |
|---|---|---|
| `--surface-base` | 井戸（最深面）。ターミナル背景と同一 | 既定値は CSS。workspace スコープ時は `useTerminalTheme` が `palette.background` を注入 |
| `--surface-fg` | 前景色 | 同上（`palette.foreground`） |
| `--surface-accent` | UIアクセント（カレント表示・スピナー・フォーカス・選択塗り） | スコープ非依存で常に注入。`cursor` が有彩色（S≥0.3, 0.3≤L≤0.85）ならそれ、無彩色なら `blue` スロット |

`--accent` と `--accent-a08/-a15/-a35` は `--surface-accent` から color-mix で
導出されるため、アクセントを参照する全オブジェクトがテーマに一括追随する。
個別の面色（`--bg-card` 等）を JS から直接上書きすることは禁止。
テーマ追加時に触ってよいのはプリセットの palette のみ。

## 2. 面の梯子は相対導出

すべての面トークンは `color-mix(in srgb, var(--surface-fg) N%, var(--surface-base))`
で導出する。N はロール別に固定:

```
bg 3% < ws-surface 6% < bg-card/ws-surface-card 9% < input-bg 12%
  < bg-hover/bg-solid 14% < input-bg-active 16% < bg-elevated 19%
```

これにより「井戸 < キャンバス < クローム < カード < 記入面 < hover < 浮遊UI」
という**順序関係**がテーマ非依存の不変則になる。絶対色をコンポーネントに
書くことは禁止（プロジェクト色などデータ由来の色を除く）。

## 3. 深さは光で表現する（のっぺり対策）

線を使わずに面を立体化するため、面は色に加えて次の対を持つ:

- 上端ハイライト: `inset 0 1px 0 var(--edge-hi)`（fg 9% の透過色）
- 落ち影: `--shadow-1`（カード）/ `--shadow-2`（ポップオーバー）/ `--shadow-3`（モーダル）

ロール対応: カード・リスト群=shadow-1 / ドロップダウン=shadow-2 /
モーダル=shadow-3 / 記入面=内側影（押し型）/ ボタン=ハイライト+微小影、
`:active` で押し込み。

## 4. workspace（背景透過）スコープの不変則

`:root[data-bg-scope="app"]` では**透過してよい面だけ**を半透明で再導出する。

- 透過する: `--bg` / `--ws-surface` / `--bg-card`（背景演出を透かす）
- 透過しない: `--bg-solid` / `--bg-elevated` / `--input-bg`（浮遊UIと記入面。
  可読性はテーマ・背景画像に対して常に保証する）

## 5. 線の使用規約

- 箱の輪郭・パネル区切りに線を使わない（`--border: transparent !important`。
  !important はテーマ機構の inline 注入に対する防御）
- 残してよい線は2種のみ:
  1. **情報を運ぶ線**: ログ種別の左レール等、色=意味の線
  2. **行間ヘアライン**: `--hairline`（fg 11% 透過）による隣接行の区切り
- 新規コンポーネントで「線でしか存在しない要素」を作らない。
  存在は面（塗り）で、階層は梯子で、深さは §3 の対で示す

## 6. 注意信号の優先権

稼働ネオン（`.aw-row-working`）・承認待ちスロブ（`.aw-blocked-dot`）・
タブ comet は本アプリの最優先色彩。地は常にこれらより静かに保ち、
新たな装飾色をクロームに足さない。

## 7. 新規コンポーネントのチェックリスト

- [ ] 面色はトークン参照のみ（絶対色なし）
- [ ] 浮いた面に §3 の対（ハイライト+影）があるか
- [ ] workspace スコープ（半透明時）で可読か
- [ ] Dracula / Nord など明度の異なるプリセットで階層順序が保たれるか
- [ ] 線を追加していないか（§5 の2種を除く）

## 8. design-lint ガード

上記規約のうち機械的に検出できるものは、eslint 等を追加せず
`packages/frontend/scripts/design-lint.mjs`（依存ゼロの Node スクリプト）で
`packages/frontend/src` 配下を静的にチェックする。

### 実行方法

```bash
npm run design-lint -w packages/frontend
# または packages/frontend で: node scripts/design-lint.mjs
```

対象外: `src/themes/**`、`src/components/ui/pixel-icons/**`、
`src/components/AzitoLogo*.tsx`、`*.test.*`。

### 検出ルール

| # | ルール | レベル |
|---|---|---|
| 1 | `window.confirm(` / `window.alert(` / 素の `alert(` の禁止（`useConfirm()`/toast を使う） | fail |
| 2 | 生の hex カラー（`#rgb`〜`#rrggbbaa`）禁止（トークン使用を強制） | fail |
| 3 | `fontSize: <数値>` / `borderRadius: <数値>`（0 を除く）の直書き禁止 | fail |
| 4 | `transition: 'all ...'` の禁止（アニメ対象プロパティを明示する） | fail |
| 5 | `zIndex: <数値>` が z スケール（10, 50, 100, 300, 400）外 | warn（非ブロッキング。トークン移行未了のため） |
| 6 | `components/ui/Icon.tsx` / `custom-icons.ts` 以外からの `from 'lucide-react'` 直import禁止 | fail |
| 7 | `global.css` 以外での `var(--green` / `var(--red` / `var(--orange` 直参照禁止（`--success`/`--danger`/`--warning` を使う） | fail |

fail レベルの違反が1件でもあれば `exit 1`。warn は常に出力されるが終了コードには影響しない。

### 例外の許可（エスケープ）

- **特定行の除外**: 該当行に `// lint-allow: <tag>` コメント（理由も添える）を付ける。
  1行の `style={{ ... }}` オブジェクトのように `//` が残りのコードを巻き込んでしまう位置では、
  代わりに `/* lint-allow: <tag> - 理由 */` をその式の中にインラインで置く。
  タグ: `dialog` `hex` `scale` `transition` `lucide` `token` `zindex`
- **ファイル単位の除外**: スクリプト内 `FILE_ALLOWLIST` 配列に `{ file, rule, reason }` を追加する。
  ANSI カラーテーブルのような「ファイル全体が生の色データそのもの」なケース専用。
  将来の別の違反も拾えなくなるため、基本は行単位の `lint-allow` を優先する。

### 既知のベースライン例外

- 「アクセント/success/warning/danger の単色塗りに白文字」パターン（`color: '#fff'` 等）:
  現状 on-color トークンが存在しないため、行単位で `lint-allow: hex` を付与済み
  （新規トークン追加は本ガード導入のスコープ外）。
- `PROJECT_COLORS` / `COLOR_PRESETS` 等プロジェクトカラーのプリセット・既定値: §1 の
  「プロジェクト色などデータ由来の色を除く」に該当するため許可。
- `TaskPanel.tsx` / `PhaseProgressBar.tsx` の `#ffa600`（計画レビュー待ち）、
  `#6495ed`（入力待ち）: success/warning/danger の3値にまだ属さない専用の注意色。
- aurora グラデーションの既定色（`themes/presets.ts` の値をミラー）: 外観エディタの
  デフォルト値として複数箇所に重複。
- `utils/ansi.ts`: ANSI/xterm の色テーブルはファイル単位で許可（`FILE_ALLOWLIST`）。
