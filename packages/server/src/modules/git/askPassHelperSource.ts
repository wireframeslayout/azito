/**
 * `GIT_ASKPASS` の共通ヘルパー（Node スクリプト）の中身。リリース版は esbuild の単一ファイルにまとまりヘルパーの
 * ファイルが同梱されないので、中身を文字列で持ち、`HubGitSupport` が起動後に書き出す。
 *
 * 秘密はこのスクリプトにも書かない。Git が起動する子プロセスの環境変数（`AZITO_GIT_ASKPASS_TOKEN` /
 * `AZITO_GIT_ASKPASS_USERNAME`）から読む。プロンプトが `Username for ...` ならユーザー名、それ以外
 * （`Password for ...`）ならトークンを返す。環境変数が無いときは理由を stderr に出して失敗する（既定値は返さない）。
 */
export const ASKPASS_TOKEN_ENV = 'AZITO_GIT_ASKPASS_TOKEN';
export const ASKPASS_USERNAME_ENV = 'AZITO_GIT_ASKPASS_USERNAME';

export const ASKPASS_HELPER_SOURCE = `'use strict';
const prompt = process.argv[2] || '';
const name = /^username\\b/i.test(prompt) ? '${ASKPASS_USERNAME_ENV}' : '${ASKPASS_TOKEN_ENV}';
const value = process.env[name];
if (!value) {
  process.stderr.write('azito-askpass: ' + name + ' is not set\\n');
  process.exit(1);
}
process.stdout.write(value + '\\n');
`;
