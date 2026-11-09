const ALLOWED_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  // codex --help: --ignore-user-config を付けても auth 情報は CODEX_HOME を見に行く。
  // 落とすと CODEX_HOME を使う構成で認証が失敗する。
  'CODEX_HOME',
  // 環境変数ベースの認証で使われる（非対話実行時の CODEX_API_KEY、
  // 標準的な OPENAI_API_KEY、`codex login --with-api-key` 系の CODEX_ACCESS_TOKEN）
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
  // 独自 TLS ルートを使う環境向け
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CODEX_CA_CERTIFICATE',
  // プロキシ経由でしか外部到達できない環境向け（大文字/小文字の両方を尊重する慣習に合わせる）
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

export function buildAllowedEnv(extraKeys: readonly string[] = [], excludedKeys: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...ALLOWED_ENV_KEYS, ...extraKeys]) {
    if (excludedKeys.includes(key)) continue;
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
