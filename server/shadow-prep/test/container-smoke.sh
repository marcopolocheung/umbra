#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
image=umbra-shadow-prep-smoke
data_root=$(mktemp -d)
trap 'rm -rf "$data_root"' EXIT

docker build -f "$repo_root/server/shadow-prep/Containerfile" -t "$image" "$repo_root"
set +e
output=$(docker run --rm -v "$data_root:/data" "$image" admit 2>&1)
status=$?
set -e
printf '%s\n' "$output"

if [ "$status" -eq 0 ]; then
  echo "smoke expected fail-closed admission, but admit succeeded" >&2
  exit 1
fi
if grep -Eqi 'cannot find module|ERR_MODULE_NOT_FOUND|tsx' <<<"$output"; then
  echo "smoke found a module-resolution failure instead of admission logic" >&2
  exit 1
fi
if ! grep -Eqi 'boundary admission blocked|regional manifest rejected' <<<"$output"; then
  echo "smoke did not reach admission logic" >&2
  exit 1
fi
