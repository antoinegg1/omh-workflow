#!/bin/bash

set -euo pipefail

while true; do
    codex exec \
        --dangerously-bypass-approvals-and-sandbox \
        --skip-git-repo-check \
        --model "gpt-5.6-sol" \
        -c 'model_reasoning_effort="max"' \
        -c 'service_tier="default"' \
        < TASK.md || true
    sleep 5
    kimi --prompt "$(cat TASK.md)" \
        --model "kimi-code/k3" \
        || true
    sleep 5
done
