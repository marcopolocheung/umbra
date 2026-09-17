#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
launcher="$script_dir/submit-nyc-browser-pack.sh"
mock="$script_dir/test-fixtures/mock-browser-pack-aws.sh"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT

image_sha=0123456789abcdef0123456789abcdef01234567
common_args=(
  --execute --v2 --image-sha "$image_sha"
  --support-geometry 's3:raw:support.json' --support-sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  --candidate-tile-geometry 's3:raw:candidate.json' --candidate-tile-sha256 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  --borough-boundary 's3:raw:boundary.json' --admission-manifest 's3:evidence:admission.json'
)

run_case() {
  local name="$1"
  shift
  local directory="$scratch/$name"
  mkdir -p "$directory"
  MOCK_AWS_LOG="$directory/aws.log" EXPECTED_IMAGE_SHA="$image_sha" AWS_CLI="$mock" \
    "$@" "$launcher" "${common_args[@]}" >"$directory/stdout" 2>"$directory/stderr"
}

# Preflight is ordered after index and before the array; failure prevents every
# expensive child submission.
if run_case preflight-failure env MOCK_PREFLIGHT_FAIL=1; then
  echo "expected preflight failure" >&2
  exit 1
fi
grep -q 'submit|nyc-browser-pack-index-' "$scratch/preflight-failure/aws.log"
grep -q 'submit|nyc-browser-pack-preflight-' "$scratch/preflight-failure/aws.log"
if grep -q 'submit|nyc-browser-pack-array-' "$scratch/preflight-failure/aws.log"; then
  echo "array was submitted after failed preflight" >&2
  exit 1
fi

# Only failed indices become ordinary retry jobs; the 126 successful children
# are never submitted again, and aggregation follows the two successes.
run_case targeted-retry env MOCK_FAILED_INDICES='3 7'
log="$scratch/targeted-retry/aws.log"
grep -q 'submit|nyc-browser-pack-array-.*|size=128|' "$log"
grep -q 'submit|nyc-browser-pack-retry-3-' "$log"
grep -q 'submit|nyc-browser-pack-retry-7-' "$log"
[[ "$(grep -c 'submit|nyc-browser-pack-retry-' "$log")" -eq 2 ]]
grep 'submit|nyc-browser-pack-retry-3-' "$log" | grep -q '"--shard-index","3"'
grep 'submit|nyc-browser-pack-retry-7-' "$log" | grep -q '"--shard-index","7"'
grep -q 'submit|nyc-browser-pack-aggregate-' "$log"
array_line="$(grep -n 'submit|nyc-browser-pack-array-' "$log" | cut -d: -f1)"
aggregate_line="$(grep -n 'submit|nyc-browser-pack-aggregate-' "$log" | cut -d: -f1)"
[[ "$aggregate_line" -gt "$array_line" ]]

# One failed targeted retry is a hard stop, so aggregation is never submitted.
if run_case retry-failure env MOCK_FAILED_INDICES='3 7' MOCK_RETRY_FAIL=7; then
  echo "expected targeted retry failure" >&2
  exit 1
fi
if grep -q 'submit|nyc-browser-pack-aggregate-' "$scratch/retry-failure/aws.log"; then
  echo "aggregation was submitted after a repeated shard failure" >&2
  exit 1
fi

# Every resolved definition must point at the exact reviewed SHA before even
# the index is submitted.
if run_case image-mismatch env MOCK_IMAGE_MISMATCH=1; then
  echo "expected image mismatch failure" >&2
  exit 1
fi
[[ ! -s "$scratch/image-mismatch/aws.log" ]]

echo "submit-nyc-browser-pack mocked-AWS tests passed"
