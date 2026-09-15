#!/usr/bin/env bash
set -euo pipefail

# This script is deliberately inert unless the operator types --execute.
# It creates the index, waits for it, submits exactly 128 array children, then
# submits the aggregate gate. It never writes current.json or deploys a site.
if [[ "${1:-}" != "--execute" ]]; then
  echo "Dry run only. Review this script, then run: $0 --execute"
  exit 0
fi

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
if [[ "${quota%.*}" -lt "$array_size" ]]; then
  echo "Refusing to submit: EC2 standard On-Demand vCPU quota is $quota; need $array_size." >&2
  exit 1
fi

submit_and_wait() {
  local name="$1" definition="$2" array_arg="${3:-}"
  local job_id
  if [[ -n "$array_arg" ]]; then
    job_id="$(aws batch submit-job --region "$region" --job-name "$name" --job-queue "$queue" --job-definition "$definition" --array-properties "$array_arg" --query jobId --output text)"
  else
    job_id="$(aws batch submit-job --region "$region" --job-name "$name" --job-queue "$queue" --job-definition "$definition" --query jobId --output text)"
  fi
  echo "$name submitted: $job_id"
  aws batch wait job-execution-succeeded --region "$region" --jobs "$job_id"
  echo "$name succeeded: $job_id"
}

run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
submit_and_wait "nyc-browser-pack-index-$run_stamp" "$index_definition"
submit_and_wait "nyc-browser-pack-array-$run_stamp" "$array_definition" "size=$array_size"
submit_and_wait "nyc-browser-pack-aggregate-$run_stamp" "$aggregate_definition"
echo "Complete. Inspect the final immutable manifest in R2; current.json remains unchanged."
