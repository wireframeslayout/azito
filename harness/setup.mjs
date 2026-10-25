#!/usr/bin/env node
// AZITO Harness setup, Node version (used on Windows; POSIX keeps setup.sh).
//
//   node setup.mjs [--azito-url <url>] [--webhook-token <t>] [--ui-token <t>] [--server-name <name>] [--prefix <name>]
//                  [--purge-operator-token]
//
// Does what setup.sh does, without a shell, a symbolic link or `chmod`: the skills (`/azt-*`) are junctions and the rules are
// copies (lib/links.mjs), azitoctl*.env / operator.env are written in the Windows form and kept owner-only (lib/secretFile.mjs),
// and ~/.claude/settings.json gets the MCP server and the Node hooks (hooks/azito-hook.mjs).
// The tokens may also come from AZITO_WEBHOOK_TOKEN / AZITO_UI_TOKEN in the environment, so that a caller can keep them out
// of the argument list (the hub does).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexHomeOf, findOnPath, registerCodexMcp, stripCodexUiToken, writeAgentsBlock } from './lib/codex.mjs';
import { purgeOperatorEnv, scrubLegacyUiToken, writeAzitoctlEnv, writeOperatorEnv } from './lib/envFiles.mjs';
import { copyRules, linkSkills } from './lib/links.mjs';
import { PREFIX_PATTERN, mergeClaudeSettings } from './lib/claudeSettings.mjs';
import { createSecretFiles } from './lib/secretFile.mjs';

const DEFAULT_URL = 'http://localhost:3001';

/** Reads the command line (and the environment as the default). Throws on a usage error. */
export function parseSetupArgs(argv, env) {
  const options = {
    azitoUrl: env.AZITO_URL ?? '',
    webhookToken: env.AZITO_WEBHOOK_TOKEN ?? '',
    uiToken: env.AZITO_UI_TOKEN ?? '',
    serverName: env.AZITO_SERVER_NAME ?? '',
    prefix: env.AZITO_PREFIX ?? '',
    purge: false,
  };
  let uiTokenGiven = false;
  const keys = { '--azito-url': 'azitoUrl', '--webhook-token': 'webhookToken', '--ui-token': 'uiToken', '--server-name': 'serverName', '--prefix': 'prefix' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--purge-operator-token') {
      options.purge = true;
      continue;
    }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (!(flag in keys)) throw new Error(`Unknown option: ${arg}`);
    let value = inline;
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`Option ${flag} requires a value`);
    }
    options[keys[flag]] = value;
    if (flag === '--ui-token') uiTokenGiven = true;
  }
  // Checked here, before any file name is made from it (azitoctl-<prefix>.env).
  if (options.prefix && (!PREFIX_PATTERN.test(options.prefix) || options.prefix.includes('..'))) {
    throw new Error(`--prefix に使える文字は英数字と . _ - です（先頭は英数字、.. は不可）: ${options.prefix}`);
  }
  if (options.purge) {
    if (uiTokenGiven) throw new Error('--purge-operator-token と --ui-token は同時指定できません');
    // An inherited AZITO_UI_TOKEN must not be written back in the run that purges it.
    options.uiToken = '';
  }
  return options;
}

/** Runs the setup. `host` carries what the entry point resolved: platform, environment, home directory, harness directory. */
export function runSetup(options, host, log) {
  const { platform, env, homeDir, harnessDir } = host;
  const errors = [];
  const fail = (message) => {
    errors.push(message);
    console.error(`  エラー: ${message}`);
  };
  const azitoDir = path.join(homeDir, '.azito');
  const claudeDir = path.join(homeDir, '.claude');
  const secrets = createSecretFiles({ platform, env });
  const azitoUrlValue = options.azitoUrl || DEFAULT_URL;
  const modeSkipped = options.purge ? '  スキップ (--purge-operator-token)' : '  スキップ (--prefix モード)';
  const linksEnabled = !options.purge && !options.prefix;

  log('AZITO Harness セットアップ');
  log(`ハーネス: ${harnessDir}`);
  if (options.azitoUrl) log(`AZITO URL: ${options.azitoUrl}`);
  if (options.prefix) log(`Prefix: ${options.prefix}`);

  log('\n=== Skills ===');
  if (linksEnabled) linkSkills({ harnessDir, destDir: path.join(claudeDir, 'skills'), platform, log });
  else log(modeSkipped);

  log('\n=== Rules (prompt-modules) ===');
  if (linksEnabled) copyRules({ harnessDir, destDir: path.join(claudeDir, 'rules'), manifestFile: path.join(azitoDir, 'harness-copies.json'), log });
  else log(modeSkipped);

  log('\n=== Settings (settings.json) ===');
  if (!options.azitoUrl) {
    console.error(`WARNING: --azito-url が未指定のため ${DEFAULT_URL} を使用します。\nリモートサーバーでは必ず --azito-url で hub の URL を指定してください。`);
  }
  try {
    for (const line of mergeClaudeSettings({
      settingsPath: path.join(claudeDir, 'settings.json'),
      hookScript: path.join(harnessDir, 'hooks', 'azito-hook.mjs'),
      mcpServerPath: path.join(harnessDir, 'skills', 'azt-mcp', 'mcp-server', 'index.js'),
      azitoUrl: azitoUrlValue,
      uiToken: options.uiToken,
      prefix: options.prefix,
      purge: options.purge,
    })) log(line);
  } catch (err) {
    fail(err.message);
  }
  log(options.webhookToken ? '  AZITO_WEBHOOK_TOKEN: 設定済み（azitoctl env ファイルに保存）' : '  AZITO_WEBHOOK_TOKEN: 未設定（通知・稼働検出には --webhook-token が必要）');
  log(options.serverName ? '  AZITO_SERVER_NAME: 設定済み' : '  AZITO_SERVER_NAME: 未設定（稼働検出には --server-name が必要）');

  log('\n=== azitoctl.env ===');
  const scrub = scrubLegacyUiToken(azitoDir, secrets);
  scrub.messages.forEach((m) => log(`  ${m}`));
  scrub.errors.forEach(fail);
  if (options.azitoUrl && options.webhookToken) {
    const file = writeAzitoctlEnv(azitoDir, options, secrets);
    log(`  ${file}: 書き出しました（AZITO_UI_TOKEN は含みません）`);
  } else {
    log('  スキップ (--azito-url と --webhook-token の両方が必要)');
  }

  log('\n=== operator.env ===');
  if (options.purge) {
    const purged = purgeOperatorEnv(azitoDir);
    if (purged.error) fail(purged.error);
    else log(`  ${purged.message}`);
  }
  if (options.uiToken) {
    const file = writeOperatorEnv(azitoDir, { azitoUrl: azitoUrlValue, uiToken: options.uiToken }, secrets);
    log(`  ${file}: 書き出しました`);
  } else {
    log('  スキップ (--ui-token が未指定)');
  }

  setupCodex({ options, host, codexHome: codexHomeOf(env, homeDir), harnessDir, azitoUrlValue, log, fail });

  log('\nセットアップ完了');
  return errors;
}

function setupCodex({ options, host, codexHome, harnessDir, azitoUrlValue, log, fail }) {
  const { platform, env } = host;
  log('\n=== Codex CLI ===');
  if (options.purge) stripCodexUiToken({ configFile: path.join(codexHome, 'config.toml'), fail, log });
  if (options.prefix) return log('  スキップ (--prefix モード)');
  if (options.purge) return log('  スキップ (--purge-operator-token — トークン除去のみ実施済み)');
  const codexFound = findOnPath('codex', env, platform) !== null;
  if (!codexFound && !fs.existsSync(codexHome)) return log('  スキップ (codex 未検出)');

  linkSkills({ harnessDir, destDir: path.join(codexHome, 'skills'), platform, log });
  if (codexFound) {
    registerCodexMcp({
      codexHome,
      mcpServerPath: path.join(harnessDir, 'skills', 'azt-mcp', 'mcp-server', 'index.js'),
      azitoUrl: azitoUrlValue,
      uiToken: options.uiToken,
      ctx: { env, platform },
      log,
      fail,
    });
  } else {
    log('  azt-mcp: スキップ (codex コマンドが見つかりません)');
  }
  writeAgentsBlock({ agentsPath: path.join(codexHome, 'AGENTS.md'), modulesDir: path.join(harnessDir, 'prompt-modules'), log });
}

function main() {
  let options;
  try {
    options = parseSetupArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(err.message);
    console.error('Usage: node setup.mjs [--azito-url <url>] [--webhook-token <t>] [--ui-token <t>] [--server-name <name>] [--prefix <name>] [--purge-operator-token]');
    process.exit(1);
  }
  const host = { platform: process.platform, env: process.env, homeDir: os.homedir(), harnessDir: path.dirname(fileURLToPath(import.meta.url)) };
  let errors;
  try {
    errors = runSetup(options, host, (line) => console.log(line));
  } catch (err) {
    console.error(`setup.mjs failed: ${err.message}`);
    process.exit(1);
  }
  if (errors.length > 0) {
    console.error('\n警告: 一部の手順が失敗しました（上記ログを確認してください）');
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
