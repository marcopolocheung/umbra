#!/usr/bin/env bash
set -euo pipefail

# This script is deliberately inert unless the operator types --execute. It
# pins every job definition to the reviewed merge-SHA image, builds/verifies
# the frozen index, validates all live v2 inputs, runs exactly 128 shards, and
# submits aggregation only after every shard has a successful receipt. It
# never writes current.json or deploys a site.
if [[ "${1:-}" != "--execute" ]]; then
  echo "Dry run only. Review this script, then run: $0 --execute --v2 --image-sha <full-merge-sha> ..."
  exit 0
fi
shift

v2=0
expected_image_sha=""
support_geometry=""
support_sha=""
candidate_tile_geometry=""
candidate_tile_sha=""
borough=""
admission_manifest=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --v2) v2=1; shift ;;
    --image-sha) expected_image_sha="${2:-}"; shift 2 ;;
    --support-geometry) support_geometry="${2:-}"; shift 2 ;;
    --support-sha256) support_sha="${2:-}"; shift 2 ;;
    --candidate-tile-geometry) candidate_tile_geometry="${2:-}"; shift 2 ;;
    --candidate-tile-sha256) candidate_tile_sha="${2:-}"; shift 2 ;;
    --borough-boundary) borough="${2:-}"; shift 2 ;;
    --admission-manifest) admission_manifest="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ "$v2" != 1 ]]; then
  echo "This guarded launcher requires --v2." >&2
  exit 1
fi
if [[ ! "$expected_image_sha" =~ ^[a-f0-9]{40}$ ]]; then
  echo "--image-sha must be the full 40-character lowercase merge SHA." >&2
  exit 1
fi
if ! command -v jq >/dev/null; then
  echo "jq is required to construct and inspect Batch JSON safely." >&2
  exit 1
fi

aws_cli="${AWS_CLI:-aws}"
aws_call() { "$aws_cli" "$@"; }
stack_name="${SHADE_PREP_STACK_NAME:-shademap-prep}"
region="${AWS_REGION:-us-east-1}"
array_size=128

output_value() {
  aws_call cloudformation describe-stacks --region "$region" --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

queue="$(output_value BatchQueue)"
repository_uri="$(output_value EcrRepositoryUri)"
evidence_bucket="$(output_value EvidenceBucket)"
index_definition="$(output_value BrowserPackIndexJobDefinition)"
array_definition="$(output_value BrowserPackArrayJobDefinition)"
aggregate_definition="$(output_value BrowserPackAggregateJobDefinition)"
expected_image="${repository_uri}:${expected_image_sha}"

verify_definition_image() {
  local label="$1" definition="$2" image
  image="$(aws_call batch describe-job-definitions --region "$region" --job-definitions "$definition" \
    --query 'jobDefinitions[0].containerProperties.image' --output text)"
  if [[ "$image" != "$expected_image" ]]; then
    echo "Refusing to submit: $label resolves to $image, expected $expected_image." >&2
    exit 1
  fi
}
verify_definition_image index "$index_definition"
verify_definition_image array "$array_definition"
verify_definition_image aggregate "$aggregate_definition"

quota="$(aws_call service-quotas get-service-quota --region "$region" --service-code ec2 --quota-code L-1216C47A --query 'Quota.Value' --output text)"
if [[ "${quota%.*}" -lt 1 ]]; then
  echo "Refusing to submit: EC2 standard On-Demand vCPU quota is $quota; need at least one." >&2
  exit 1
fi
if [[ "${quota%.*}" -lt "$array_size" ]]; then
  echo "Using the currently approved $quota vCPUs: the $array_size-child array will run in waves."
fi

if [[ -z "$support_geometry" || -z "$support_sha" || -z "$candidate_tile_geometry" || -z "$candidate_tile_sha" || -z "$borough" ]]; then
  echo "v2 needs support geometry/hash, candidate-tile geometry/hash, and --borough-boundary." >&2
  exit 1
fi
if [[ -z "$admission_manifest" ]]; then
  admission_manifest="s3:${evidence_bucket}:evidence/admission/new-york-city-v1.json"
elif [[ "$admission_manifest" != s3:* ]]; then
  echo "v2 --admission-manifest must be an s3:<bucket>:<key> object spec; Batch does not mount local admission files." >&2
  exit 1
fi

common_v2_args=(
  --support-geometry "$support_geometry"
  --support-sha256 "$support_sha"
  --candidate-tile-geometry "$candidate_tile_geometry"
  --candidate-tile-sha256 "$candidate_tile_sha"
  --admission-manifest "$admission_manifest"
)

override_json() {
  jq -cn --args '$ARGS.positional | {command: .}' -- "$@"
}

preflight_overrides="$(override_json \
  server/shadow-prep/src/pack-full-cli.ts --validate-v2-inputs \
  "${common_v2_args[@]}" --borough-boundary "$borough")"
array_overrides="$(override_json \
  server/shadow-prep/src/pack-full-cli.ts --pack-shard --array-shards "$array_size" \
  "${common_v2_args[@]}")"
aggregate_overrides="$(override_json \
  server/shadow-prep/src/pack-full-cli.ts --aggregate --array-shards "$array_size" \
  "${common_v2_args[@]}" --borough-boundary "$borough")"

submit_job() {
  local name="$1" definition="$2" array_arg="${3:-}" overrides="${4:-}"
  local submit=(aws_call batch submit-job --region "$region" --job-name "$name" --job-queue "$queue" --job-definition "$definition")
  if [[ -n "$array_arg" ]]; then submit+=(--array-properties "$array_arg"); fi
  if [[ -n "$overrides" ]]; then submit+=(--container-overrides "$overrides"); fi
  "${submit[@]}" --query jobId --output text
}

wait_for_job() {
  local name="$1" job_id="$2" status
  while true; do
    status="$(aws_call batch describe-jobs --region "$region" --jobs "$job_id" --query 'jobs[0].status' --output text)"
    case "$status" in
      SUCCEEDED) echo "$name succeeded: $job_id"; return 0 ;;
      FAILED)
        aws_call batch describe-jobs --region "$region" --jobs "$job_id" --output json >&2
        return 1
        ;;
      SUBMITTED|PENDING|RUNNABLE|STARTING|RUNNING) sleep 15 ;;
      *) echo "Unexpected Batch status for $job_id: $status" >&2; return 1 ;;
    esac
  done
}

submit_and_wait() {
  local name="$1" definition="$2" array_arg="${3:-}" overrides="${4:-}" job_id
  job_id="$(submit_job "$name" "$definition" "$array_arg" "$overrides")"
  echo "$name submitted: $job_id"
  wait_for_job "$name" "$job_id"
}

failed_indices=()
wait_for_array_children() {
  local job_id="$1" parent_status succeeded_json failed_json succeeded_count failed_count
  while true; do
    parent_status="$(aws_call batch describe-jobs --region "$region" --jobs "$job_id" --query 'jobs[0].status' --output text)"
    succeeded_json="$(aws_call batch list-jobs --region "$region" --array-job-id "$job_id" --job-status SUCCEEDED \
      --query 'jobSummaryList[].arrayProperties.index' --output json)"
    failed_json="$(aws_call batch list-jobs --region "$region" --array-job-id "$job_id" --job-status FAILED \
      --query 'jobSummaryList[].arrayProperties.index' --output json)"
    succeeded_count="$(jq 'length' <<<"$succeeded_json")"
    failed_count="$(jq 'length' <<<"$failed_json")"
    if [[ $((succeeded_count + failed_count)) -eq "$array_size" ]]; then
      if [[ "$parent_status" != SUCCEEDED && "$parent_status" != FAILED ]]; then
        echo "All array children are terminal but parent $job_id is $parent_status; waiting for its terminal state."
        sleep 15
        continue
      fi
      mapfile -t failed_indices < <(jq -r 'sort[]' <<<"$failed_json")
      if [[ "$failed_count" -eq 0 && "$parent_status" == SUCCEEDED ]]; then return 0; fi
      if [[ "$failed_count" -gt 0 && "$parent_status" == FAILED ]]; then return 1; fi
      echo "Array parent/child status mismatch: parent=$parent_status succeeded=$succeeded_count failed=$failed_count" >&2
      return 2
    fi
    case "$parent_status" in
      SUBMITTED|PENDING|RUNNABLE|STARTING|RUNNING|FAILED|SUCCEEDED) sleep 15 ;;
      *) echo "Unexpected Batch array status for $job_id: $parent_status" >&2; return 2 ;;
    esac
  done
}

run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
submit_and_wait "nyc-browser-pack-index-$run_stamp" "$index_definition"
submit_and_wait "nyc-browser-pack-preflight-$run_stamp" "$aggregate_definition" "" "$preflight_overrides"

array_name="nyc-browser-pack-array-$run_stamp"
array_job_id="$(submit_job "$array_name" "$array_definition" "size=$array_size" "$array_overrides")"
echo "$array_name submitted: $array_job_id"
if wait_for_array_children "$array_job_id"; then
  echo "$array_name succeeded: all $array_size children"
else
  array_result=$?
  if [[ "$array_result" -ne 1 || "${#failed_indices[@]}" -eq 0 ]]; then
    echo "Array did not produce an exact terminal partition; refusing retries and aggregation." >&2
    exit 1
  fi
  echo "$array_name failed at indices: ${failed_indices[*]}; retrying each once as an ordinary job." >&2
  for shard_index in "${failed_indices[@]}"; do
    retry_overrides="$(override_json \
      server/shadow-prep/src/pack-full-cli.ts --pack-shard --array-shards "$array_size" --shard-index "$shard_index" \
      "${common_v2_args[@]}")"
    if ! submit_and_wait "nyc-browser-pack-retry-${shard_index}-$run_stamp" "$array_definition" "" "$retry_overrides"; then
      echo "Shard $shard_index failed its only targeted retry; aggregation will not be submitted." >&2
      exit 1
    fi
  done
  echo "All ${#failed_indices[@]} targeted shard retries succeeded; all $array_size receipt indices are now successful."
fi

submit_and_wait "nyc-browser-pack-aggregate-$run_stamp" "$aggregate_definition" "" "$aggregate_overrides"
echo "Complete. The Worker serves the new generation only behind its published root marker; current.json remains unchanged."
echo "Next: pack-full-cli --promote --verify-only, then --promote --expected-previous-sha256 <live-current.json-sha256>."
