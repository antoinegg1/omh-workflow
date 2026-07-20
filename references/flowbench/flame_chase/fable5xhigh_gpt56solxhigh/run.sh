#!/bin/bash

set -euo pipefail

while true; do
    claude --print \
        --dangerously-skip-permissions \
        --model "claude-fable-5" \
        --effort "xhigh" \
        < TASK.md || true
    sleep 5
    codex exec \
        --dangerously-bypass-approvals-and-sandbox \
        --skip-git-repo-check \
        --model "gpt-5.6-sol" \
        -c 'model_reasoning_effort="xhigh"' \
        -c 'service_tier="default"' \
        < TASK.md || true
    sleep 5
done
