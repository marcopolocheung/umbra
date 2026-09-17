#!/usr/bin/env bash
set -euo pipefail

value_after() {
  local wanted="$1"
  shift
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "$wanted" ]]; then printf '%s' "${2:-}"; return 0; fi
    shift
  done
  return 1
}

command_name="${1:-} ${2:-}"
case "$command_name" in
  "cloudformation describe-stacks")
    query="$(value_after --query "$@")"
    case "$query" in
      *BatchQueue*) echo queue ;;
      *EcrRepositoryUri*) echo 111111111111.dkr.ecr.us-east-1.amazonaws.com/shademap-prep ;;
      *EvidenceBucket*) echo evidence-bucket ;;
      *BrowserPackIndexJobDefinition*) echo browser-index:7 ;;
      *BrowserPackArrayJobDefinition*) echo browser-array:9 ;;
      *BrowserPackAggregateJobDefinition*) echo browser-aggregate:11 ;;
      *) echo "unexpected stack output query: $query" >&2; exit 2 ;;
    esac
    ;;
  "batch describe-job-definitions")
    if [[ "${MOCK_IMAGE_MISMATCH:-0}" == 1 ]]; then
      echo 111111111111.dkr.ecr.us-east-1.amazonaws.com/shademap-prep:wrong
    else
      echo "111111111111.dkr.ecr.us-east-1.amazonaws.com/shademap-prep:${EXPECTED_IMAGE_SHA}"
    fi
    ;;
  "service-quotas get-service-quota") echo 128.0 ;;
  "batch submit-job")
    name="$(value_after --job-name "$@")"
    overrides="$(value_after --container-overrides "$@" || true)"
    array="$(value_after --array-properties "$@" || true)"
    printf 'submit|%s|%s|%s\n' "$name" "$array" "$overrides" >>"$MOCK_AWS_LOG"
    echo "${name}-job"
    ;;
  "batch describe-jobs")
    job_id="$(value_after --jobs "$@")"
    status=SUCCEEDED
    if [[ "$job_id" == *browser-pack-preflight* && "${MOCK_PREFLIGHT_FAIL:-0}" == 1 ]]; then status=FAILED; fi
    if [[ "$job_id" == *browser-pack-array* && -n "${MOCK_FAILED_INDICES:-}" ]]; then status=FAILED; fi
    if [[ "$job_id" == *browser-pack-retry-${MOCK_RETRY_FAIL:--1}-* ]]; then status=FAILED; fi
    if [[ " $* " == *" --query "* ]]; then echo "$status"; else printf '{"jobs":[{"status":"%s"}]}\n' "$status"; fi
    ;;
  "batch list-jobs")
    wanted="$(value_after --job-status "$@")"
    failed=" ${MOCK_FAILED_INDICES:-} "
    values=()
    for ((index=0; index<128; index++)); do
      if [[ "$failed" == *" $index "* ]]; then
        [[ "$wanted" == FAILED ]] && values+=("$index")
      else
        [[ "$wanted" == SUCCEEDED ]] && values+=("$index")
      fi
    done
    printf '['
    separator=""
    for index in "${values[@]}"; do printf '%s%s' "$separator" "$index"; separator=,; done
    printf ']\n'
    ;;
  *) echo "unexpected mock AWS command: $*" >&2; exit 2 ;;
esac
