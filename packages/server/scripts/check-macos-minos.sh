#!/usr/bin/env bash
# Fails when a Mach-O file in the unpacked hub bundle needs a newer macOS than MACOSX_DEPLOYMENT_TARGET.
# The release runner's macOS can be newer than the oldest macOS the bundle supports; native modules compiled
# there (and prebuilt ones) must still load on the oldest one. Reads LC_BUILD_VERSION / LC_VERSION_MIN_MACOSX with otool.
set -euo pipefail

root="${1:?usage: check-macos-minos.sh <unpacked bundle dir>}"
target="${MACOSX_DEPLOYMENT_TARGET:?MACOSX_DEPLOYMENT_TARGET is not set}"
checked=0
failed=0

# Prints a version as one comparable number: 13.5 and 13.5.0 are the same, 13.10 is newer than 13.9.
version_key() {
  awk -F. '{ printf "%d%03d%03d\n", $1, $2, $3 }' <<<"$1"
}
target_key=$(version_key "$target")

while IFS= read -r -d '' file; do
  if ! file -b "$file" | grep -q 'Mach-O'; then
    continue
  fi
  versions=$(otool -l "$file" | awk '
    /cmd LC_BUILD_VERSION/ { want = "minos" }
    /cmd LC_VERSION_MIN_MACOSX/ { want = "version" }
    want != "" && $1 == want { print $2; want = "" }
  ')
  if [ -z "$versions" ]; then
    echo "no minimum macOS recorded: ${file#"$root"/}" >&2
    failed=1
    continue
  fi
  for version in $versions; do
    if [ "$(version_key "$version")" -gt "$target_key" ]; then
      echo "needs macOS $version (> $target): ${file#"$root"/}" >&2
      failed=1
    else
      echo "minos $version: ${file#"$root"/}"
    fi
  done
  checked=$((checked + 1))
done < <(find "$root" -type f \( -name '*.node' -o -name 'spawn-helper' -o -name 'node' -o -name 'misao' \) -print0)

if [ "$checked" -eq 0 ]; then
  echo "no Mach-O files were checked under $root" >&2
  exit 1
fi
exit "$failed"
