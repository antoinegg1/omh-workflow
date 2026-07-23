# GLM-5.2 ROCm MI300X No-Regression Maximize Plan

## Goal Description

Start a second KDA-Pilot style Claude/Codex RLCR optimization loop for
`/home/lichangye/kernel-harness-amd`.

This loop treats the first KDA-Pilot result as the accepted baseline and tries to
increase performance as much as practical, while preserving the kernel-harness
standard:

- every evaluated shape must remain correct;
- no shape may regress under the conservative primary-util gate;
- taskset, workload, correctness thresholds, reference paths, cost model,
  deployment metadata, and scoring semantics must remain unchanged.

The objective is not merely to pass the official gate again. The objective is to
maximize the official ROCm/MI300X `roofline_mfu_bw` outcomes without losing any
accepted win.

## Current Accepted Baseline

Use these persisted first-loop results as the baseline to beat. A second-loop
change is only a win if it preserves correctness and no-regression while
improving at least one official metric relative to these values.

| Task | Run ID | Shapes | Geomean primary-util ratio | Min conservative primary-util ratio | Geomean MFU | Geomean BW util | Worst calc_diff |
|------|--------|--------|----------------------------|-------------------------------------|-------------|------------------|-----------------|
| `moe_total_decode` | `20260722T083714Z-126708` | 2/2 wins | `1.0655` | `1.0518` | `0.030953` | `0.340746` | `0` |
| `moe_total_prefill` | `20260722T083730Z-959e52` | 3/3 wins | `1.0809` | `1.0263` | `0.266527` | `0.061196` | `0` |
| `dsa_prefill_attn` | `20260722T083802Z-1b233d` | 3/3 wins | `1.3044` | `1.2603` | `0.034010` | `0.005563` | `2.8841951178470993e-06` |
| `index_score_prefill` | `20260722T084041Z-7a3d33` | 3/3 wins | `2.8371` | `1.5375` | `0.121637` | `0.030325` | `0` |

## Acceptance Criteria

### AC-1: Preflight authority is frozen

Positive tests:

- `git status --short --untracked-files=all` is clean except ignored
  `.humanize/` state before starting implementation.
- `tasksets/glm52_rocm_local.json` remains the scoring taskset.
- `score_model.official_metrics` remains exactly:
  `dsa_prefill_attn`, `index_score_prefill`, `moe_total_prefill`,
  `moe_total_decode`.
- Hardware selection remains `rocm / amd-mi300x / aiter-torch-reference /
  event`.
- `python3 testbench/bin/selftest.py` passes.
- `python3 testbench/bin/sync_glm52_tasks.py --check` passes under default
  ROCm environment.

Negative tests:

- Changing taskset membership, workload axes, correctness thresholds, reference
  functions, cost model, device peaks, timing semantics, or deployment metadata
  is rejected.
- Branch switching is rejected. Stay on the current working branch.

### AC-2: Correctness and no-regression are hard constraints

Positive tests:

- Every modified official task passes pre-timing and post-timing correctness on
  every evaluated shape.
- Every official task still has `shapes_regressed == 0`.
- Existing accepted wins are not lost.
- A changed task must improve at least one of:
  `geomean_primary_util_ratio`, `geomean_primary_util_ratio_conservative`,
  `min_primary_util_ratio_conservative`, or `shapes_won`, while keeping
  `shapes_regressed == 0`.

Negative tests:

- A candidate that improves one shape but regresses another is rejected unless
  the regressing shape is routed to the reference and becomes neutral.
- A candidate that only falls back to the reference on every shape is rejected.
- A single `--repeat 1` probe is not sufficient for a final claim.

### AC-3: Optimization target is maximize under constraints

Primary objective:

- Maximize official-task `geomean_primary_util_ratio` across the four official
  metrics, with no conservative shape regressions.

Secondary objectives:

- Improve `min_primary_util_ratio_conservative`.
- Increase `shapes_won` where possible.
- Improve absolute MFU for compute-bound shapes and BW util for memory-bound
  shapes.
- Prefer smaller, candidate-local changes over harness or metadata changes.

### AC-4: Evidence must be comparable to the accepted baseline

Positive tests:

- For any claimed improvement, report candidate and reference latency, bound,
  MFU, BW util, TFLOP/s, GB/s, primary-util ratio, conservative ratio, and
  `calc_diff` per shape.
- Persist result JSON under `runs/glm52/<task>/<run_id>/result.json` or a
  clearly named `/opt/devmachine/lichangye/tmp/` artifact.
- Compare against the accepted baseline table above.

Negative tests:

- Reporting raw latency only is rejected.
- Reporting diagnostic MoE split rows as official MoE totals is rejected.
- If the authoritative gate cannot run, final status must be
  blocked or complete-with-caveats, not clean complete.

### AC-5: Final diff remains reviewable

Positive tests:

- Final diff excludes `.humanize/`, raw traces, caches, binaries, build outputs,
  and scratch logs.
- Candidate changes are documented by task and shape.
- Any no-go exploration is recorded with the bottleneck and why it was stopped.

Negative tests:

- Broad harness refactors, generated metadata churn, or non-target task rewrites
  are rejected unless the owner explicitly authorizes them during the loop.

## Fixed Commands

Use this environment before GPU work:

```bash
source /home/lichangye/rocm_env.sh
cd /home/lichangye/kernel-harness-amd
```

Preflight:

```bash
git status --short --untracked-files=all
python3 testbench/bin/selftest.py
env -u KERNEL_HARNESS_PLATFORM -u KERNEL_HARNESS_PROFILE -u KERNEL_HARNESS_PROVIDER -u KERNEL_HARNESS_TIMER \
  python3 testbench/bin/sync_glm52_tasks.py --check
```

Gate-quality task run:

```bash
"$ROCM_TORCH_VENV/bin/python" testbench/tasks/glm52/TASK_ID/run.sh \
  --repeat 10 --iterations 30 --warmup 3
```

Taskset run for selected official tasks:

```bash
"$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py \
  --taskset tasksets/glm52_rocm_local.json \
  --task TASK_ID \
  --repeat 10 --iterations 30 --warmup 3 \
  --json-out /opt/devmachine/lichangye/tmp/kda_round2_TASK_ID_${RUN_ID:-manual}.json
```

Full official-task check:

```bash
for task in moe_total_decode moe_total_prefill dsa_prefill_attn index_score_prefill; do
  "$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py \
    --taskset tasksets/glm52_rocm_local.json \
    --task "$task" \
    --repeat 10 --iterations 30 --warmup 3 \
    --json-out "/opt/devmachine/lichangye/tmp/kda_round2_${task}_${RUN_ID:-manual}.json"
done
```

## Target Prioritization

Prioritize by expected remaining headroom, but keep all four accepted targets
protected:

1. `dsa_prefill_attn` - low absolute MFU; search for a faster ROCm sparse-MLA
   implementation while preserving the current 3/3 correctness margin.
2. `index_score_prefill` - high accepted speedup but still modest absolute MFU;
   try launch-config or tiling refinements only if they remain bit-exact.
3. `moe_total_prefill` - improve fused total only, not diagnostic split rows,
   and preserve the existing 3/3 wins.
4. `moe_total_decode` - memory-bound; only pursue changes with a credible BW
   utilization path and no decode-shape regression.

The loop may stop early only after it either lands a no-regression improvement
or documents no-go evidence for all plausible candidate-local directions within
the round budget.

## Task Breakdown

| Task ID | Description | Target AC | Tag | Depends On |
|---------|-------------|-----------|-----|------------|
| task1 | Verify clean preflight, finalized first-loop state, ROCm defaults, selftest, sync check, and accepted baseline artifacts. | AC-1, AC-4 | coding | - |
| task2 | Review the baseline and identify which official task has the best no-regression headroom. | AC-3, AC-4 | analyze | task1 |
| task3 | Inspect the selected task contract, current candidate, reference path, and per-shape result JSON. | AC-2, AC-4 | coding | task2 |
| task4 | Review reward-hacking risks and decide one concrete candidate-local optimization direction or no-go. | AC-2, AC-3 | analyze | task3 |
| task5 | Implement the smallest candidate-local change for the selected task. | AC-2, AC-3, AC-5 | coding | task4 |
| task6 | Run correctness, probe, and gate-quality benchmarks for the modified task. | AC-2, AC-4 | coding | task5 |
| task7 | Compare new result against the accepted baseline; keep only if it improves without regression. | AC-2, AC-3, AC-4 | analyze | task6 |
| task8 | Iterate on the same task or advance to the next prioritized official task. | AC-3 | coding | task7 |
| task9 | Run a final official-task check for all four targets and ensure no accepted win was lost. | AC-2, AC-4 | coding | task8 |
| task10 | Finalize concise report: diff, commands, artifacts, per-shape MFU/BW changes, no-go attempts, and remaining headroom. | AC-4, AC-5 | coding | task9 |

## Stop Conditions

Clean complete is allowed only if:

- all correctness and no-regression constraints pass;
- at least one official metric improves beyond the accepted first-loop baseline,
  or all plausible candidate-local directions are documented as no-go under the
  available budget;
- final evidence includes comparable MFU/BW and primary-util ratio data.

Do not mark clean complete if:

- the authoritative gate is unavailable;
- any official task regresses;
- the only improvement comes from metadata, taskset, threshold, reference, or
  evaluator changes;
- the final state relies only on `--repeat 1` probes.
