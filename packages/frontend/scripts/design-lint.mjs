#!/usr/bin/env node
/**
 * design-lint: standalone Kasumi design-convention guard for packages/frontend/src.
 *
 * No eslint stack exists in this repo (checked: no root/frontend .eslintrc*, no eslint
 * devDependency). Rather than bring in the eslint dependency graph for ~7 regex-shaped
 * rules, this is a small dependency-free Node script (fs/path only) that enforces the
 * conventions documented in docs/ja/ui-surface-policy.md.
 *
 * Usage:
 *   node scripts/design-lint.mjs           # from packages/frontend
 *   npm run design-lint -w packages/frontend
 *
 * Exit code: 0 = clean (fail-level rules have no unallowed violations), 1 = violations found.
 * Warn-level rules (currently only zIndex) are always printed but never affect the exit code.
 *
 * Escaping a specific line:
 *   Add a comment `// lint-allow: <tag>[ - reason]` (or `/* lint-allow: <tag>[ - reason] *\/`
 *   inline, e.g. inside a single-line style={{ }} object where a `//` would swallow the
 *   rest of the line) anywhere on the offending line.
 *   Tags: dialog, hex, scale, transition, lucide, token, zindex
 *
 * Escaping a whole file (only for files that are baseline-legitimate wholesale, e.g. a
 * color-constant table): add an entry to FILE_ALLOWLIST below with a reason.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SRC_ROOT = join(__dirname, '..', 'src');

// Directories/files excluded from every rule (theming internals, generated icon data,
// the brand mark, and test files — see task spec for rationale).
const EXCLUDED_DIR_PREFIXES = ['themes/', 'components/ui/pixel-icons/'];
const EXCLUDED_FILE_PATTERNS = [/^components\/AzitoLogo.*\.tsx$/, /\.test\./];

// Whole-file exemptions. Keep this list small — prefer a per-line `// lint-allow: <tag>`
// comment so future unrelated additions in the same file still get checked. Only use this
// for files that are entirely/inherently about raw color values.
const FILE_ALLOWLIST = [
  {
    file: 'utils/ansi.ts',
    rule: 'hex',
    reason: 'ANSI 16/256-color terminal palette + xterm color-index tables — raw RGB is the actual data, not UI chrome.',
  },
];

const RULE_TAGS = {
  dialog: 'dialog',
  hex: 'hex',
  scale: 'scale',
  transition: 'transition',
  lucide: 'lucide',
  token: 'token',
  zindex: 'zindex',
};

const ALLOWED_Z_INDEX = new Set([10, 50, 100, 300, 400]);
const ALLOWED_LUCIDE_IMPORTERS = new Set(['components/ui/Icon.tsx', 'components/ui/custom-icons.ts']);

/** @type {{ file: string; line: number; rule: string; message: string; snippet: string }[]} */
const violations = [];
/** @type {{ file: string; line: number; rule: string; message: string; snippet: string }[]} */
const warnings = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.isFile() && (extname(entry) === '.ts' || extname(entry) === '.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function isExcluded(relPath) {
  if (EXCLUDED_DIR_PREFIXES.some((p) => relPath.startsWith(p))) return true;
  if (EXCLUDED_FILE_PATTERNS.some((re) => re.test(relPath))) return true;
  return false;
}

function isFileAllowed(relPath, rule) {
  return FILE_ALLOWLIST.some((e) => e.file === relPath && e.rule === rule);
}

/**
 * Extracts `lint-allow: tag1, tag2 - reason` tags present anywhere on the line, written as
 * either a `// lint-allow: ...` line comment or a `/* lint-allow: ... *\/` block comment.
 * The block form is required inside single-line JSX attribute expressions (e.g.
 * `style={{ color: '#fff' /* lint-allow: hex - ... *\/, fontSize: ... }}`), since a `//`
 * comment there would swallow the rest of the object literal and any JSX that follows.
 */
function lineAllowTags(line) {
  const m = line.match(/\/[/*]\s*lint-allow:\s*([a-z, ]+)/i);
  if (!m) return new Set();
  return new Set(
    m[1]
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isPureCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** The portion of a line before a `//` comment marker (naive but sufficient: none of our
 * rule patterns legitimately contain `//` inside the code portion itself). */
function codePortion(line) {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

function report(bucket, file, lineNum, rule, message, rawLine) {
  bucket.push({ file, line: lineNum, rule, message, snippet: rawLine.trim().slice(0, 140) });
}

function checkFile(absPath) {
  const relPath = relative(SRC_ROOT, absPath).split('\\').join('/');
  if (isExcluded(relPath)) return;

  const content = readFileSync(absPath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((rawLine, idx) => {
    const lineNum = idx + 1;
    const allow = lineAllowTags(rawLine);

    // --- Rule 1: native dialogs -------------------------------------------------
    if (!isPureCommentLine(rawLine) && !allow.has(RULE_TAGS.dialog)) {
      const code = codePortion(rawLine);
      if (/\bwindow\.confirm\(|\bwindow\.alert\(/.test(code) || /(^|[^.\w])alert\(/.test(code)) {
        report(
          violations,
          relPath,
          lineNum,
          'dialog',
          'Native window.confirm/window.alert/alert() is banned — use useConfirm()/toast instead.',
          rawLine
        );
      }
    }

    // --- Rule 2: raw hex colors --------------------------------------------------
    if (!isFileAllowed(relPath, RULE_TAGS.hex) && !allow.has(RULE_TAGS.hex) && !isPureCommentLine(rawLine)) {
      const code = codePortion(rawLine);
      // Exempt `var(--token, #hex)` fallbacks: the hex is anchored to a real token
      // reference and only used if that token is somehow undefined, not an arbitrary
      // standalone color.
      const exemptSpans = [];
      const fallbackRe = /var\(\s*--[\w-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/g;
      let fm;
      while ((fm = fallbackRe.exec(code))) {
        exemptSpans.push([fm.index, fm.index + fm[0].length]);
      }
      const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
      let hm;
      while ((hm = hexRe.exec(code))) {
        const pos = hm.index;
        if (code[pos - 1] === '&') continue; // HTML numeric entity, e.g. &#8601;
        if (exemptSpans.some(([s, e]) => pos >= s && pos < e)) continue; // var() fallback
        report(violations, relPath, lineNum, 'hex', `Raw hex color ${hm[0]} — use a design token.`, rawLine);
      }
    }

    // --- Rule 3: hardcoded scale literals -----------------------------------------
    if (!allow.has(RULE_TAGS.scale)) {
      const code = codePortion(rawLine);
      const scaleRe = /\b(fontSize|borderRadius)\s*:\s*(-?\d+(?:\.\d+)?)\b/g;
      let sm;
      while ((sm = scaleRe.exec(code))) {
        const num = Number(sm[2]);
        if (num !== 0) {
          report(
            violations,
            relPath,
            lineNum,
            'scale',
            `Hardcoded ${sm[1]}: ${sm[2]} — use a var(--font-*)/var(--radius-*) token.`,
            rawLine
          );
        }
      }
    }

    // --- Rule 4: transition: 'all -------------------------------------------------
    if (!allow.has(RULE_TAGS.transition)) {
      const code = codePortion(rawLine);
      if (/transition\s*:\s*['"`]all\b/.test(code)) {
        report(
          violations,
          relPath,
          lineNum,
          'transition',
          `transition: 'all ...' is banned — list the specific properties that animate.`,
          rawLine
        );
      }
    }

    // --- Rule 5: zIndex scale (warn only) ------------------------------------------
    if (!allow.has(RULE_TAGS.zindex)) {
      const code = codePortion(rawLine);
      const zRe = /\bzIndex\s*:\s*(-?\d+)\b/g;
      let zm;
      while ((zm = zRe.exec(code))) {
        const num = Number(zm[1]);
        if (!ALLOWED_Z_INDEX.has(num)) {
          report(
            warnings,
            relPath,
            lineNum,
            'zindex',
            `zIndex: ${num} is not one of the z-scale tokens (10, 50, 100, 300, 400).`,
            rawLine
          );
        }
      }
    }

    // --- Rule 6: lucide-react imports outside the icon wrapper ---------------------
    if (!allow.has(RULE_TAGS.lucide) && !ALLOWED_LUCIDE_IMPORTERS.has(relPath)) {
      const code = codePortion(rawLine);
      if (/from\s+['"]lucide-react['"]/.test(code)) {
        report(
          violations,
          relPath,
          lineNum,
          'lucide',
          `Direct lucide-react import — import from components/ui/Icon.tsx (or custom-icons.ts) instead.`,
          rawLine
        );
      }
    }

    // --- Rule 7: raw semantic color vars outside global.css ------------------------
    // (global.css itself is never scanned here — only .ts/.tsx — so any match found by
    // this rule is by definition "outside global.css".)
    if (!allow.has(RULE_TAGS.token)) {
      const code = codePortion(rawLine);
      if (/var\(--green|var\(--red|var\(--orange/.test(code)) {
        report(
          violations,
          relPath,
          lineNum,
          'token',
          `Raw var(--green/--red/--orange) — use the semantic token (--success/--danger/--warning) instead.`,
          rawLine
        );
      }
    }
  });
}

function formatEntry(e) {
  return `  ${e.file}:${e.line}  [${e.rule}]  ${e.message}\n      ${e.snippet}`;
}

function main() {
  const files = walk(SRC_ROOT);
  files.forEach(checkFile);

  if (warnings.length > 0) {
    console.log(`\n\u26a0 ${warnings.length} warning(s) (zIndex scale — non-blocking):\n`);
    warnings.forEach((w) => console.log(formatEntry(w)));
  }

  if (violations.length > 0) {
    console.log(`\n\u2717 ${violations.length} design-lint violation(s):\n`);
    violations.forEach((v) => console.log(formatEntry(v)));
    console.log(
      `\nFix the code, or if this is a deliberate, justified exception add a trailing ` +
        `"// lint-allow: <tag>" comment (see docs/ja/ui-surface-policy.md).\n`
    );
    process.exit(1);
  }

  console.log(`\u2713 design-lint: no violations (${files.length} files checked, ${warnings.length} warning(s)).`);
  process.exit(0);
}

main();
