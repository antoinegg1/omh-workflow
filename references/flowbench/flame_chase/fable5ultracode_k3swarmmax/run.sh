#!/bin/bash

set -euo pipefail

while true; do
    claude --print \
        --dangerously-skip-permissions \
        --model "claude-fable-5" \
        --effort "ultracode" \
        < TASK.md || true
    sleep 5
    python run.py || true
    sleep 5
done
