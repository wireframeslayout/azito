// ~/.azito/azitoctl[-<prefix>].env and ~/.azito/operator.env, in the Windows form: one `KEY="value"` per line, the value a JSON
// string (azito-hook.mjs reads it; the bash `printf %q` form of setup.sh is not written here). Files with the same names are
// found by the hub the same way (packages/server/src/shared/azitoctlEnv.ts: `^azitoctl(?:-.+)?\.env$`).
import fs from 'node:fs';
import path from 'node:path';

const AZITOCTL_ENV_NAME = /^azitoctl(-.+)?\.env$/;
const UI_TOKEN_LINE = /^AZITO_UI_TOKEN=/m;

export function formatEnvLine(key, value) {
  return `${key}=${JSON.stringify(value)}`;
}

export function azitoctlEnvName(prefix) {
  return `azitoctl${prefix ? `-${prefix}` : ''}.env`;
}

/**
 * AZITO_UI_TOKEN is never written to azitoctl*.env (it is read by processes that run under a task principal; the operator
 * credential lives in operator.env). A file an older setup left it in is cleaned, whichever prefix it belongs to. A symlink
 * (dotfiles management) is not edited: it is reported, with the token still in it.
 * Returns the messages to print and the errors found.
 */
export function scrubLegacyUiToken(azitoDir, secrets) {
  const messages = [];
  const errors = [];
  if (!fs.existsSync(azitoDir)) return { messages, errors };
  for (const name of fs.readdirSync(azitoDir)) {
    if (!AZITOCTL_ENV_NAME.test(name)) continue;
    const file = path.join(azitoDir, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      if (UI_TOKEN_LINE.test(fs.readFileSync(file, 'utf8'))) {
        errors.push(`${file} はシンボリックリンクです（リンク先: ${fs.readlinkSync(file)}）。dotfiles 管理等の可能性があるため自動編集しません。リンク先のファイルを手動で確認し、AZITO_UI_TOKEN を除去してください`);
      }
      continue;
    }
    if (!stat.isFile()) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!UI_TOKEN_LINE.test(text)) continue;
    const kept = text.split('\n').filter((line) => !/^AZITO_UI_TOKEN=/.test(line)).join('\n');
    secrets.writeSecretFile(file, kept);
    messages.push(`${file}: 旧 AZITO_UI_TOKEN 行を除去しました`);
  }
  return { messages, errors };
}

/** Writes azitoctl[-prefix].env. Returns the path. The webhook token is in it, so it is a secret file. */
export function writeAzitoctlEnv(azitoDir, { prefix, azitoUrl, webhookToken, serverName }, secrets) {
  const file = path.join(azitoDir, azitoctlEnvName(prefix));
  const lines = [formatEnvLine('AZITO_URL', azitoUrl), formatEnvLine('AZITO_WEBHOOK_TOKEN', webhookToken)];
  if (serverName) lines.push(formatEnvLine('AZITO_SERVER_NAME', serverName));
  secrets.writeSecretFile(file, `${lines.join('\n')}\n`);
  return file;
}

export function writeOperatorEnv(azitoDir, { azitoUrl, uiToken }, secrets) {
  const file = path.join(azitoDir, 'operator.env');
  const lines = [
    '# AZITO operator credentials',
    '#',
    '# このファイルは人間が明示的に読み込んで使うためのものです（PowerShell: 下の 2 つの値を $env:AZITO_URL /',
    '# $env:AZITO_UI_TOKEN に設定）。setup.mjs を含むいかなるスクリプトからも自動で読み込んではいけません。',
    '# 読み込んだ時点でそのシェルはオペレーター権限（全権）で動作します。',
    formatEnvLine('AZITO_URL', azitoUrl),
    formatEnvLine('AZITO_UI_TOKEN', uiToken),
  ];
  secrets.writeSecretFile(file, `${lines.join('\n')}\n`);
  return file;
}

/** --purge-operator-token: operator.env holds only these two lines, so it is deleted as a whole. A symlink is reported, not followed. */
export function purgeOperatorEnv(azitoDir) {
  const file = path.join(azitoDir, 'operator.env');
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return { message: `${file}: 存在しないためスキップ (--purge-operator-token)` };
    throw err;
  }
  if (stat.isSymbolicLink()) {
    return { error: `${file} はシンボリックリンクです（リンク先: ${fs.readlinkSync(file)}）。dotfiles 管理等の可能性があるため自動削除しません。リンク先のファイルを手動で確認し、AZITO_UI_TOKEN を除去してください` };
  }
  fs.rmSync(file, { force: true });
  return { message: `${file}: --purge-operator-token により削除しました` };
}
