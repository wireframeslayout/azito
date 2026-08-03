---
description: TypeScript / React のコーディング規約
globs: "*.ts,*.tsx"
---

<instructions>

## 型

- エクスポートする関数には引数と戻り値の型を明示する。ローカル変数は推論に任せる
- 拡張可能なオブジェクト型には `interface`、ユニオン・交差には `type` を使う
- `any` の代わりに `unknown` を使い、型を絞り込んでからアクセスする
- 文字列リテラルユニオンを `enum` より優先する
- バリデーションには Zod を使い、スキーマから型を導出する

## React

- JSX を含むファイルは `.tsx`、ロジックのみは `.ts`
- props は interface で定義し、引数で分割代入する
- 状態管理: useState → 必要なら lift up → Context → 外部ストア の順で検討する
- `useEffect` は副作用専用。派生データの計算やデータ変換には使わない
- `useMemo` / `useCallback` はデフォルトでは使わない。計測して必要な場合のみ追加する

## テスト

- React Testing Library でコンポーネントをテストする
- クエリの優先順位: `getByRole` → `getByLabelText` → `getByText` → `getByTestId`
- ネットワークモックには MSW (Mock Service Worker) を使う
- E2E テストには Playwright を使う

</instructions>
