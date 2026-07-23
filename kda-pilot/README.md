# KDA-Pilot Runbook for GLM-5.2 ROCm

This directory is intentionally **not** an OMH workflow. It documents the
KDA-Pilot / Humanize RLCR operating contract used for
`/home/lichangye/kernel-harness-amd`, while leaving the `glm52-rocm-kda/` OMH
flow artifact unchanged.

## Authority

The authoritative gate is the frozen GLM-5.2 ROCm taskset and evaluator:

```text
/home/lichangye/kernel-harness-amd/tasksets/glm52_rocm_local.json
/home/lichangye/kernel-harness-amd/testbench/bin/evaluate_glm52_taskset.py
```

The official hardware/profile selection is:

```text
platform: rocm
profile: amd-mi300x
provider: aiter-torch-reference
timer: event
metric: roofline_mfu_bw
```

Official tasks:

```text
dsa_prefill_attn
index_score_prefill
moe_total_prefill
moe_total_decode
```

Do not change taskset membership, workload shapes, correctness thresholds,
reference functions, score model, cost model, device peaks, timer semantics, or
deployment metadata during candidate optimization.

## Model Split

- Implementer: Claude Code, launched with `claude --permission-mode
  bypassPermissions --model opus --effort max`.
- Reviewer/adjudicator: Codex, `gpt-5.5:xhigh`, timeout `5400`.
- KDA-Pilot state used `push_every_round: false`; agents may commit locally but
  must not push `kernel-harness-amd` unless the owner explicitly asks.

## Environment

Use the persistent ROCm environment:

```bash
source /home/lichangye/rocm_env.sh
cd /home/lichangye/kernel-harness-amd
```

Large payloads live under `/mnt/public/lichangye/rocm-env`. Keep venvs,
SGLang/AITER checkouts, and build caches there rather than in tmpfs.

For authoritative GLM-5.2 gates, run with:

```bash
export AITER_TRITON_ONLY=0
```

Do not set `AITER_TRITON_ONLY` inside `candidate.py`; set it for the whole gate
environment so candidate and reference use the same ROCm/SGLang path.

## Launch Commands

Start Claude Code:

```bash
source /home/lichangye/rocm_env.sh
cd /home/lichangye/kernel-harness-amd
claude --permission-mode bypassPermissions --model opus --effort max
```

First loop:

```text
/humanize:start-rlcr-loop .humanize/kernel-agent/refined-plan.md --skip-quiz --claude-answer-codex --max 12 --codex-model gpt-5.5:xhigh --codex-timeout 5400 --base-branch kda-base/glm52-rocm-mfu-bw-20260722
```

Second no-regression maximize loop:

```text
/humanize:start-rlcr-loop .humanize/kernel-agent/refined-plan-round2-no-regression-maximize.md --skip-quiz --claude-answer-codex --max 16 --codex-model gpt-5.5:xhigh --codex-timeout 5400 --base-branch kda-base/glm52-rocm-mfu-bw-20260722
```

## Gate Commands

Preflight:

```bash
source /home/lichangye/rocm_env.sh
cd /home/lichangye/kernel-harness-amd
git status --short --untracked-files=all
python3 testbench/bin/selftest.py
env -u KERNEL_HARNESS_PLATFORM -u KERNEL_HARNESS_PROFILE -u KERNEL_HARNESS_PROVIDER -u KERNEL_HARNESS_TIMER \
  python3 testbench/bin/sync_glm52_tasks.py --check
```

Gate-quality single task:

```bash
export AITER_TRITON_ONLY=0
"$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py \
  --taskset tasksets/glm52_rocm_local.json \
  --task TASK_ID \
  --repeat 10 --iterations 30 --warmup 3 \
  --json-out /opt/devmachine/lichangye/tmp/kda_TASK_ID_${RUN_ID:-manual}.json
```

If a generated task `run.sh` selects the wrong Python, use the ROCm Python and
the harness evaluator instead of editing generated wrappers:

```bash
"$ROCM_TORCH_VENV/bin/python" testbench/harness/evaluate_task.py \
  testbench/tasks/glm52/TASK_ID \
  --repeat 10 --iterations 30 --warmup 3
```

## Stop Policy

Clean completion requires:

- every official evaluated shape is correct;
- every official task has `shapes_regressed == 0`;
- accepted wins are not lost;
- at least one official metric improves, or all plausible candidate-local
  directions are documented as no-go within the budget;
- final evidence includes MFU/BW, latency, TFLOP/s, GB/s, primary-util ratio,
  conservative ratio, calc_diff, command, commit, and JSON artifact path;
- final diff excludes `.humanize/`, raw traces, caches, binaries, build outputs,
  and scratch logs.

If the authoritative gate cannot run, exit blocked or complete-with-caveats, not
clean complete.

## Latest Accepted Results

Latest four-task gate-quality snapshot from the second loop:

| Task | Wins | Geomean primary-util ratio | Min conservative ratio | Worst calc_diff | Status |
|---|---:|---:|---:|---:|---|
| `moe_total_decode` | 2/2 | 1.0551 | 1.0454 | 0 | accepted, unchanged candidate |
| `moe_total_prefill` | 3/3 | 1.0459 | 1.0038 | 0 | accepted, `GROUP_SIZE_M=16` for M>=4096 |
| `dsa_prefill_attn` | 3/3 | 2.1213 | 2.0691 | ~2.884e-6 | accepted, aiter bf16 GEMM with fp32 output |
| `index_score_prefill` | 3/3 | 2.8416 | 1.5321 | 0 | accepted, unchanged from prior best |

Reusable BitLesson IDs:

- `BL-20260723-aiter-fp32yq-mfma-qk`
- `BL-20260723-aiter-ck-submodule-module-quant-restore`
- `BL-20260723-moe-tail-shape-config-reshift`
- `BL-20260723-dual-knowledge-base-requirement`
- `BL-20260723-archive-rebuild-committed-inputs`
