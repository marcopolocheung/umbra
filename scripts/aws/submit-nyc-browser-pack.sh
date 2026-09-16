#!/usr/bin/env bash
set -euo pipefail

# This script is deliberately inert unless the operator types --execute.
# It creates the index, waits for it, submits exactly 128 array children, then
# submits the aggregate gate. It never writes current.json or deploys a site.
#
# PR2 adds a v2 mode for the corrected generation
# (nyc-70e3507f16d472adf5475b614a60cb16-five-borough-v2), which repairs
# building support from hash-pinned geometry at pack time:
#
#   $0 --execute --v2 \
#     --support-geometry s3:<evidence-bucket>:inputs/support.geojson \
#     --support-sha256 <acquisition-manifest-pin> \
#     --borough-boundary s3:<evidence-bucket>:inputs/borough.geojson
#
# The admitted manifest is retained by `shadow-prep` under the evidence
# bucket. The launcher supplies its fully qualified object spec to every
# child (default: `s3:${EvidenceBucket}:evidence/admission/new-york-city-v1.json`);
# the image has no host `/workspace/admission` mount.
#
# Promotion stays a separate explicit step afterwards (pack-full-cli
# --promote --verify-only, then --promote --expected-previous-sha256).
if [[ "${1:-}" != "--execute" ]]; then
  echo "Dry run only. Review this script, then run: $0 --execute [--v2 ...]"
  exit 0
fi
shift

v2=0
support_geometry=""
support_sha=""
borough=""
admission_manifest=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --v2) v2=1; shift ;;
    --support-geometry) support_geometry="${2:-}"; shift 2 ;;
    --support-sha256) support_sha="${2:-}"; shift 2 ;;
    --borough-boundary) borough="${2:-}"; shift 2 ;;
    --admission-manifest) admission_manifest="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

stack_name="${SHADE_PREP_STACK_NAME:-shademap-prep}"
region="${AWS_REGION:-us-east-1}"
array_size=128
output_value() {
  aws cloudformation describe-stacks --region "$region" --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}
queue="$(output_value BatchQueue)"
index_definition="$(output_value BrowserPackIndexJobDefinition)"
array_definition="$(output_value BrowserPackArrayJobDefinition)"
aggregate_definition="$(output_value BrowserPackAggregateJobDefinition)"

quota="$(aws service-quotas get-service-quota --region "$region" --service-code ec2 --quota-code L-1216C47A --query 'Quota.Value' --output text)"
if [[ "${quota%.*}" -lt 1 ]]; then
  echo "Refusing to submit: EC2 standard On-Demand vCPU quota is $quota; need at least one." >&2
  exit 1
fi
if [[ "${quota%.*}" -lt "$array_size" ]]; then
  echo "Using the currently approved $quota vCPUs: the $array_size-child array will run in waves until the pending quota increase arrives."
fi

array_overrides=""
aggregate_overrides=""
if [[ "$v2" == 1 ]]; then
  evidence_bucket="$(output_value EvidenceBucket)"
  if [[ -z "$support_geometry" || -z "$support_sha" || -z "$borough" ]]; then
    echo "v2 needs --support-geometry, --support-sha256, and --borough-boundary." >&2
    exit 1
  fi
  if [[ -z "$admission_manifest" ]]; then
    admission_manifest="s3:${evidence_bucket}:evidence/admission/new-york-city-v1.json"
  elif [[ "$admission_manifest" != s3:* ]]; then
    echo "v2 --admission-manifest must be an s3:<bucket>:<key> object spec; Batch does not mount local admission files." >&2
    exit 1
  fi
  # Container overrides replace the job definition's v1 command for this run
  # only; the definitions themselves keep serving the v1 smoke path.
  array_overrides="$(printf '{"command":["server/shadow-prep/src/pack-full-cli.ts","--pack-shard","--array-shards","%s","--support-geometry","%s","--support-sha256","%s","--admission-manifest","%s"]}' "$array_size" "$support_geometry" "$support_sha" "$admission_manifest")"
  aggregate_overrides="$(printf '{"command":["server/shadow-prep/src/pack-full-cli.ts","--aggregate","--array-shards","%s","--borough-boundary","%s","--admission-manifest","%s"]}' "$array_size" "$borough" "$admission_manifest")"
fi

submit_and_wait() {
  local name="$1" definition="$2" array_arg="${3:-}" overrides="${4:-}"
  local job_id
  local submit=(aws batch submit-job --region "$region" --job-name "$name" --job-queue "$queue" --job-definition "$definition")
  if [[ -n "$array_arg" ]]; then submit+=(--array-properties "$array_arg"); fi
  if [[ -n "$overrides" ]]; then submit+=(--container-overrides "$overrides"); fi
  job_id="$("${submit[@]}" --query jobId --output text)"
  echo "$name submitted: $job_id"
  aws batch wait job-execution-succeeded --region "$region" --jobs "$job_id"
  echo "$name succeeded: $job_id"
}

run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
submit_and_wait "nyc-browser-pack-index-$run_stamp" "$index_definition"
submit_and_wait "nyc-browser-pack-array-$run_stamp" "$array_definition" "size=$array_size" "$array_overrides"
submit_and_wait "nyc-browser-pack-aggregate-$run_stamp" "$aggregate_definition" "" "$aggregate_overrides"
if [[ "$v2" == 1 ]]; then
  echo "Complete. The Worker serves the new generation only behind its published root marker; current.json remains unchanged."
  echo "Next: pack-full-cli --promote --verify-only, then --promote --expected-previous-sha256 <live-current.json-sha256>."
else
  echo "Complete. Inspect the final immutable manifest in R2; current.json remains unchanged."
fi
