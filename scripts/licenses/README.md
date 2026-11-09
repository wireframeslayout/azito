`exceljs-4.4.0-bundled.json` records licenses for dependencies embedded in
ExcelJS 4.4.0's prebuilt browser bundle. Its source map lists their source files,
but the package does not include a build lockfile or separate notices. Versions
were identified by matching source-map content against npm tarballs published
before ExcelJS 4.4.0; for Babel-formatted files, JavaScript was normalized first.
Unchanged files can occur in more than one release, so the recorded version is a
matching candidate, not proof of the exact build-time version. License sections
come from those tarballs. The saxes 5.0.1 license is from its upstream tag.

The Fortune Sheet npm packages omit the license file; `fortune-sheet.txt` is
from the upstream repository at commit 94346608877db4747406707a177c4b8f3bacdbf9.
Run `npx tsx scripts/generate-third-party.ts` after installing dependencies to
regenerate the distribution notices. JSZip is used under its MIT option.
