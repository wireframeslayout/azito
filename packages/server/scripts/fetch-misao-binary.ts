// Prints the path of the pinned misao binary of one target, fetching and sha256-verifying it first (see misaoAssets.ts).
// Usage: tsx scripts/fetch-misao-binary.ts <target> <dest dir>   e.g. x86_64-unknown-linux-musl
import { fetchMisaoBinary } from './misaoAssets';

const [target, destDir] = process.argv.slice(2);
if (!target || !destDir) {
  console.error('usage: fetch-misao-binary.ts <target> <dest dir>');
  process.exit(2);
}
fetchMisaoBinary(target, destDir).then(
  (binary) => console.log(binary),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
