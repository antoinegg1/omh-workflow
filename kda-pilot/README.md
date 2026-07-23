# KDA-Pilot Setup Notes for GLM-5.2 ROCm

This directory is intentionally **documentation only**. It does not vendor the
Humanize plugin, `.humanize` state, Claude caches, or KDA-Pilot run artifacts.
Use it as a reference for installing and starting KDA-Pilot on
`/home/lichangye/kernel-harness-amd`.

`glm52-rocm-kda/` remains the separate OMH workflow artifact.

## Install Humanize

KDA-Pilot was run through the Humanize Claude Code plugin:

```text
humanize@PolyArch
version: 1.16.0
source: https://github.com/PolyArch/humanize.git
commit used on this machine: 0ec921a36b4365df503511c5567bbd3e02db0df5
```

In Claude Code, install the plugin from the marketplace:

```text
/plugin marketplace add https://github.com/PolyArch/humanize.git
/plugin install humanize@PolyArch
```

Verify that the commands are available:

```text
claude plugins details humanize@PolyArch
```

The details output should include at least:

```text
gen-plan
start-rlcr-loop
ask-codex
```

## Environment

Start from the ROCm environment used by the kernel harness:

```bash
source /home/lichangye/rocm_env.sh
cd /home/lichangye/kernel-harness-amd
```

For GLM-5.2 ROCm gate runs, set:

```bash
export AITER_TRITON_ONLY=0
```

Large ROCm payloads should stay under:

```text
/mnt/public/lichangye/rocm-env
```

Do not move virtualenvs, SGLang/AITER checkouts, or build caches into this
workflow repository.

## Authority

The official gate for this KDA-Pilot run is:

```text
/home/lichangye/kernel-harness-amd/tasksets/glm52_rocm_local.json
/home/lichangye/kernel-harness-amd/testbench/bin/evaluate_glm52_taskset.py
```

The selected platform/profile/provider/timer are:

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

## Start Claude Code

```bash
source /home/lichangye/rocm_env.sh
cd /home/lichangye/kernel-harness-amd
claude --permission-mode bypassPermissions --model opus --effort max
```

Model split used by the loop:

```text
Implementer: Claude Code opus, effort max
Reviewer: Codex gpt-5.5:xhigh
Review timeout: 5400 seconds
push_every_round: false
```

Agents may commit locally when the loop contract allows it, but must not push
`kernel-harness-amd` unless the owner explicitly asks.

## Start KDA-Pilot

First loop:

```text
/humanize:start-rlcr-loop .humanize/kernel-agent/refined-plan.md --skip-quiz --claude-answer-codex --max 12 --codex-model gpt-5.5:xhigh --codex-timeout 5400 --base-branch kda-base/glm52-rocm-mfu-bw-20260722
```

Second no-regression maximize loop:

```text
/humanize:start-rlcr-loop .humanize/kernel-agent/refined-plan-round2-no-regression-maximize.md --skip-quiz --claude-answer-codex --max 16 --codex-model gpt-5.5:xhigh --codex-timeout 5400 --base-branch kda-base/glm52-rocm-mfu-bw-20260722
```

The plan files live in the target repository, not here:

```text
/home/lichangye/kernel-harness-amd/.humanize/kernel-agent/
```

## Useful Gate Commands

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

## Latest Reference Results

Latest four-task gate-quality snapshot from the second loop:

| Task | Wins | Geomean primary-util ratio | Min conservative ratio | Worst calc_diff | Status |
|---|---:|---:|---:|---:|---|
| `moe_total_decode` | 2/2 | 1.0551 | 1.0454 | 0 | accepted, unchanged candidate |
| `moe_total_prefill` | 3/3 | 1.0459 | 1.0038 | 0 | accepted, `GROUP_SIZE_M=16` for M>=4096 |
| `dsa_prefill_attn` | 3/3 | 2.1213 | 2.0691 | ~2.884e-6 | accepted, aiter bf16 GEMM with fp32 output |
| `index_score_prefill` | 3/3 | 2.8416 | 1.5321 | 0 | accepted, unchanged from prior best |

Reusable BitLesson IDs in the target repo:

- `BL-20260723-aiter-fp32yq-mfma-qk`
- `BL-20260723-aiter-ck-submodule-module-quant-restore`
- `BL-20260723-moe-tail-shape-config-reshift`
- `BL-20260723-dual-knowledge-base-requirement`
- `BL-20260723-archive-rebuild-committed-inputs`
