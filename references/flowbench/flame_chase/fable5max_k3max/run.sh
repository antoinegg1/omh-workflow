#!/bin/bash

set -euo pipefail

while true; do
    claude --print \
        --dangerously-skip-permissions \
        --model "claude-fable-5" \
        --effort "max" \
        < TASK.md || true
    sleep 5
    kimi --prompt "$(cat TASK.md)" \
        --model "kimi-code/k3" \
        || true
    sleep 5
done
