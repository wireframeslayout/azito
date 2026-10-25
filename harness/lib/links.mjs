// How the harness reaches ~/.claude and ~/.codex without a symbolic link (creating one on Windows needs Developer Mode or an
// administrator):
//  - a skill (`azt-*`, a directory) is a directory junction to the harness copy. A junction needs no privilege, follows an
//    update of the harness (the harness directory keeps its path), and is created as a plain symlink on other OSes (so the
//    same code is tested on Linux);
//  - a rule (`prompt-modules/*.md`, a file) cannot be a junction, and a hard link would break when the harness is replaced,
//    so it is copied. A copy is replaced only while it is still what was copied last time (the hash is kept in
//    ~/.azito/harness-copies.json); a file somebody edited is left alone.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sameLocation(a, b, platform) {
  const norm = (p) => {
    let s = p.replace(/^\\\\\?\\/, '');
    s = path.resolve(s).replace(/[\\/]+$/, '');
    return platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Junctions every `azt-*` skill of the harness into `destDir`. `log` prints one line per skill. */
export function linkSkills({ harnessDir, destDir, platform, log }) {
  fs.mkdirSync(destDir, { recursive: true });
  const skillsDir = path.join(harnessDir, 'skills');
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('azt-')) continue;
    const name = entry.name;
    const target = path.join(skillsDir, name);
    const link = path.join(destDir, name);
    const stat = lstatOrNull(link);
    if (stat?.isSymbolicLink()) {
      const current = fs.readlinkSync(link);
      if (sameLocation(current, target, platform)) {
        log(`  ${name}: OK (既にリンク済み)`);
        continue;
      }
      log(`  ${name}: 更新 (${current} → ${target})`);
      fs.rmSync(link, { recursive: true });
    } else if (stat?.isDirectory()) {
      log(`  ${name}: スキップ (既存ディレクトリ: ${link})`);
      log(`    ハーネス版に置き換えるには、そのディレクトリを削除して setup.mjs をもう一度実行してください`);
      continue;
    } else if (stat) {
      log(`  ${name}: スキップ (既存ファイル: ${link})`);
      continue;
    } else {
      log(`  ${name}: 作成`);
    }
    fs.symlinkSync(target, link, 'junction');
  }
}

function readManifest(manifestFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`${manifestFile} を読めません（${err.message}）。内容を確認するか削除してください`);
  }
}

/** Copies every `prompt-modules/*.md` into `destDir`, replacing only copies that are still unedited. */
export function copyRules({ harnessDir, destDir, manifestFile, log }) {
  fs.mkdirSync(destDir, { recursive: true });
  const manifest = readManifest(manifestFile);
  const modulesDir = path.join(harnessDir, 'prompt-modules');
  let manifestChanged = false;
  for (const name of fs.readdirSync(modulesDir).filter((f) => f.endsWith('.md')).sort()) {
    const data = fs.readFileSync(path.join(modulesDir, name));
    const dest = path.join(destDir, name);
    const digest = sha256(data);
    const stat = lstatOrNull(dest);
    if (stat && !stat.isFile()) {
      log(`  ${name}: スキップ (ファイルではありません: ${dest})`);
      continue;
    }
    if (stat) {
      const currentDigest = sha256(fs.readFileSync(dest));
      if (currentDigest === digest) {
        log(`  ${name}: OK (最新のコピー)`);
      } else if (manifest[dest] === currentDigest) {
        fs.writeFileSync(dest, data);
        log(`  ${name}: 更新`);
      } else {
        log(`  ${name}: スキップ (編集された既存ファイル: ${dest})`);
        log(`    ハーネス版に置き換えるには、そのファイルを削除して setup.mjs をもう一度実行してください`);
        continue;
      }
    } else {
      fs.writeFileSync(dest, data);
      log(`  ${name}: 作成`);
    }
    if (manifest[dest] !== digest) {
      manifest[dest] = digest;
      manifestChanged = true;
    }
  }
  if (manifestChanged) {
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
