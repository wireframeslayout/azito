import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { resolveDataDir } from '../shared/dataDir';
import { readEnvValue, resolveServerEnvPath } from '../shared/envFile';

function findAzitoctlEnvFiles(): string[] {
  const dir = path.join(process.env.HOME || '', '.azito');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^azitoctl(-[^.]+)?\.env$/.test(f))
    .map(f => path.join(dir, f));
}

function updateAzitoctlEnvToken(filePath: string, newToken: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let updated = false;
  const newLines = lines.map(line => {
    if (/^AZITO_UI_TOKEN=/.test(line)) {
      updated = true;
      return `AZITO_UI_TOKEN=${newToken}`;
    }
    return line;
  });
  if (updated) {
    fs.writeFileSync(filePath, newLines.join('\n'));
  }
  return updated;
}

function resolveToken(): { token: string; source: string } | null {
  const envToken = process.env.AZITO_UI_TOKEN;
  if (envToken) return { token: envToken, source: 'env' };

  const envFilePath = resolveServerEnvPath();
  const dotenvToken = readEnvValue(envFilePath, 'AZITO_UI_TOKEN');
  if (dotenvToken) return { token: dotenvToken, source: envFilePath };

  const paths = resolveDataDir();
  if (fs.existsSync(paths.uiToken)) {
    const fileToken = fs.readFileSync(paths.uiToken, 'utf-8').trim();
    if (fileToken) return { token: fileToken, source: paths.uiToken };
  }

  return null;
}

export async function tokenCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'show') {
    const result = resolveToken();
    if (result) {
      console.log(result.token);
      return;
    }
    const paths = resolveDataDir();
    const envFilePath = resolveServerEnvPath();
    console.error('UI token not found.');
    console.error(`Checked: AZITO_UI_TOKEN env, ${envFilePath}, ${paths.uiToken}`);
    console.error(`Set AZITO_UI_TOKEN in ${envFilePath}, or start the server once to auto-generate a token file.`);
    process.exit(1);
  }

  if (subcommand === 'rotate') {
    const paths = resolveDataDir();
    const newToken = crypto.randomBytes(32).toString('hex');

    fs.mkdirSync(path.dirname(paths.uiToken), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.uiToken, newToken, { mode: 0o600 });
    console.log(`New UI token written to ${paths.uiToken}`);

    const envFilePath = resolveServerEnvPath();
    const dotenvToken = readEnvValue(envFilePath, 'AZITO_UI_TOKEN');
    if (dotenvToken) {
      console.warn(`\nWarning: ${envFilePath} に AZITO_UI_TOKEN が設定されているため、rotate したファイルトークンより .env の値が優先されます。.env 側も更新してください。`);
    }

    const envFiles = findAzitoctlEnvFiles();
    for (const envFile of envFiles) {
      if (updateAzitoctlEnvToken(envFile, newToken)) {
        console.log(`Updated AZITO_UI_TOKEN in ${envFile}`);
      }
    }

    if (process.stdout.isTTY) {
      console.log(`\nNew token: ${newToken}`);
    } else {
      console.log('New token written. Read it from the file above.');
    }
    console.log('Restart the server for the new token to take effect.');
    return;
  }

  console.error('Usage: azito token <show|rotate>');
  process.exit(1);
}
