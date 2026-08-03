---
description: PHP / Laravel のコーディング規約
globs: "*.php"
---

<instructions>

## 型と安全性

- `declare(strict_types=1)` を全ファイルに付ける
- 関数の引数と戻り値に型宣言を付ける
- プロパティにも型宣言を付ける（PHP 7.4+）
- 不確実な入力には `unknown` 相当の扱いで型チェックしてから使う

## Laravel パターン

- コントローラーは薄く保つ。ビジネスロジックは Service クラスに置く
- バリデーションは FormRequest で行う
- クエリは Eloquent / Query Builder を使う。生SQLの文字列結合はしない
- 構造化データの受け渡しには DTO（Data Transfer Object）を使う

## テスト

- テストランナー: `php artisan test` または `./vendor/bin/phpunit`
- Feature テスト（HTTP テスト）でエンドポイントの動作を検証する
- ファクトリとシーダーでテストデータを用意する

## フォーマット

- PSR-12 に従う
- Laravel Pint または PHP-CS-Fixer でフォーマットする

</instructions>
