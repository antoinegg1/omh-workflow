# KDA-Pilot Workflow for GLM-5.2 ROCm

This runbook captures the KDA-Pilot style Humanize RLCR workflow that was used
for `/home/lichangye/kernel-harness-amd`. It is intentionally separate from the
static OMH DAG in this directory:

- `glm52-rocm-kda.omhflow` is the 3-worker / 2-searcher OMH artifact for the
  `/home/lichangye/glm52-rocm-kda` campaign package.
- This file documents the owner-operated Humanize RLCR loop that optimized the
  GLM-5.2 MI300X taskset directly inside `kernel-harness-amd`.

## Operating Contract

The authoritative gate is the frozen GLM-5.2 ROCm taskset plus the
`roofline_mfu_bw` evaluator:

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
```

The official metrics are exactly:

```text
dsa_prefill_attn
index_score_prefill
moe_total_prefill
moe_total_decode
```

Do not change taskset membership, workload shapes, correctness thresholds,
reference functions, score model, cost model, device peaks, timer semantics, or
deployment metadata during an optimization loop. Metadata/harness authority
fixes are owner actions, not candidate actions.

## Model Roles

Observed KDA-Pilot RLCR split:

- Implementation: Claude Code with `claude --permission-mode bypassPermissions
  --model opus --effort max`.
- Review/adjudication: Codex with `gpt-5.5:xhigh`, timeout `5400` seconds.
- RLCR state records `push_every_round: false`; agents may commit locally but
  must not push `kernel-harness-amd` unless the owner explicitly asks.

The `.omhflow` file in this directory has its own role routing. Do not treat the
OMH role mapping as the source of truth for the Humanize RLCR runs described
here.

## Environment

Use the persistent ROCm environment wrapper:

```bash
source /home/lichangye/rocm_env.sh
cd /home/lichangye/kernel-harness-amd
```

Large environment payloads live under:

```text
/mnt/public/lichangye/rocm-env
```

`/home/lichangye/rocm_env.sh` exports `ROCM_TORCH_VENV`, `SGLANG_ROOT`,
`AITER_ROOT`, `TMPDIR`, `TRITON_CACHE_DIR`, and `AITER_CONFIG_DIR` to that
persistent tree. Keep virtualenvs, SGLang/AITER checkouts, and build caches
there rather than on tmpfs.

For authoritative GLM-5.2 gates, explicitly use:

```bash
export AITER_TRITON_ONLY=0
```

Do not set `AITER_TRITON_ONLY` inside `candidate.py`. The gate environment must
select the same ROCm/SGLang reference path for candidate and reference. Setting
it to `1` can silently route some references to a degraded fallback and produce
invalid wins.

## Launch Recipe

Start Claude Code from the kernel harness repo:

```bash
source /home/lichangye/rocm_env.sh
cd /home/lichangye/kernel-harness-amd
claude --permission-mode bypassPermissions --model opus --effort max
```

Inside Claude Code, start the first-loop plan:

```text
/humanize:start-rlcr-loop .humanize/kernel-agent/refined-plan.md --skip-quiz --claude-answer-codex --max 12 --codex-model gpt-5.5:xhigh --codex-timeout 5400 --base-branch kda-base/glm52-rocm-mfu-bw-20260722
```

For the second "maximize without regression" loop, use:

```text
/humanize:start-rlcr-loop .humanize/kernel-agent/refined-plan-round2-no-regression-maximize.md --skip-quiz --claude-answer-codex --max 16 --codex-model gpt-5.5:xhigh --codex-timeout 5400 --base-branch kda-base/glm52-rocm-mfu-bw-20260722
```

Before a new loop, verify that the plan's baseline table matches the committed
accepted results, and keep `push_every_round` disabled.

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

Taskset smoke:

```bash
"$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py \
  --taskset tasksets/glm52_rocm_local.json \
  --smoke --repeat 1 --iterations 1 --warmup 0 --no-gpu-lock \
  --json-out /opt/devmachine/lichangye/tmp/kda_glm52_smoke_${RUN_ID:-manual}.json
```

Gate-quality single official task:

```bash
export AITER_TRITON_ONLY=0
"$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py \
  --taskset tasksets/glm52_rocm_local.json \
  --task TASK_ID \
  --repeat 10 --iterations 30 --warmup 3 \
  --json-out /opt/devmachine/lichangye/tmp/kda_TASK_ID_${RUN_ID:-manual}.json
```

If a task-local `run.sh` resolves to the wrong Python, run the same gate through
the ROCm Python and the harness evaluator instead of editing generated wrappers:

```bash
"$ROCM_TORCH_VENV/bin/python" testbench/harness/evaluate_task.py \
  testbench/tasks/glm52/TASK_ID \
  --repeat 10 --iterations 30 --warmup 3
```

## Optimization Loop

Each productive round follows this sequence:

1. Read the persistent goal tracker and the current round contract.
2. Verify the frozen authority and environment before implementation.
3. Select one official target based on measured headroom.
4. Inspect the task ABI, `candidate.py`, workload, and reference path.
5. Ask review to approve one candidate-local direction or identify no-go risk.
6. Implement the smallest candidate-local change that can improve an official
   metric without regressing any shape.
7. Run correctness first, then probe, then gate-quality benchmark.
8. Compare against the accepted baseline and record MFU/BW evidence.
9. Keep, iterate, or revert the candidate based on conservative gate results.
10. Finalize with a bounded diff, knowledge entry, BitLesson entry, and review.

Candidate changes may use task-local Python dispatch, PyTorch ROCm, Triton ROCm,
HIP/C++ extensions, and SGLang/AITER APIs that are already present in the
configured environment. They must not rebuild inputs, reseed tensors,
re-quantize weights, loosen tolerances, edit the reference, or manipulate the
gate.

## Stop Policy

Clean completion is valid only when all of these hold:

- every official evaluated shape is correct;
- every official task has `shapes_regressed == 0`;
- accepted wins are not lost;
- at least one official metric improves, or every plausible candidate-local
  direction is documented as no-go within the budget;
- final evidence includes MFU/BW, latency, TFLOP/s, GB/s, primary-util ratio,
  conservative ratio, calc_diff, command, commit, and JSON artifact path;
- final diff excludes `.humanize/`, raw traces, caches, binaries, build outputs,
  and scratch logs.

If the authoritative gate cannot run, the loop must exit blocked or
complete-with-caveats. It must not report clean complete on unvalidated claims.

## Latest Accepted Results

Latest four-task gate-quality snapshot from the second loop:

| Task | Wins | Geomean primary-util ratio | Min conservative ratio | Worst calc_diff | Status |
|---|---:|---:|---:|---:|---|
| `moe_total_decode` | 2/2 | 1.0551 | 1.0454 | 0 | accepted, unchanged candidate |
| `moe_total_prefill` | 3/3 | 1.0459 | 1.0038 | 0 | accepted, `GROUP_SIZE_M=16` for M>=4096 |
| `dsa_prefill_attn` | 3/3 | 2.1213 | 2.0691 | ~2.884e-6 | accepted, aiter bf16 GEMM with fp32 output |
| `index_score_prefill` | 3/3 | 2.8416 | 1.5321 | 0 | accepted, unchanged from prior best |

Baseline-to-latest headline:

- `dsa_prefill_attn` improved from geomean ratio `1.3044` to `2.1213`.
- `index_score_prefill` held the accepted high-ratio result, around `2.84`.
- `moe_total_decode` and `moe_total_prefill` preserved full accepted-win
  profiles after the pinned-CK reference was restored.

## Reusable Lessons

Record or re-check these lessons before future KDA-Pilot runs:

- `BL-20260723-aiter-fp32yq-mfma-qk`: aiter `batched_gemm_bf16` can realize a
  bf16-input/fp32-output MFMA QK path when an import-time probe proves the
  caller-preallocated fp32 output is honored.
- `BL-20260723-aiter-ck-submodule-module-quant-restore`: MoE fp8 references
  need AITER's pinned CK submodule and `module_quant.so`; restore the external
  env, do not modify candidate/reference authority.
- `BL-20260723-moe-tail-shape-config-reshift`: after reference restoration,
  bit-exact MoE launch-config optima can shift; re-sweep the affected tail shape
  and gate `--repeat 10` twice before declaring a lost win.
- `BL-20260723-dual-knowledge-base-requirement`: finalization must update both
  `.humanize/bitlesson.md` and `testbench/knowledge`.
- `BL-20260723-archive-rebuild-committed-inputs`: committed archive rebuild
  helpers must read committed archive inputs, not gitignored run caches.

## Failure Handling

If ROCm torch/SGLang/AITER disappears from tmpfs, rebuild or relink the large
payload under `/mnt/public/lichangye/rocm-env` and then source
`/home/lichangye/rocm_env.sh`. Do not rebuild into `/tmp` or
`/opt/devmachine` except for disposable scratch.

If MoE gates fail before timing with `module_quant` or CK header errors, restore
the AITER checkout's own pinned submodule:

```bash
cd "$AITER_ROOT"
git submodule update --init 3rdparty/composable_kernel
```

Then rerun with `AITER_TRITON_ONLY=0`. Do not check out an arbitrary CK commit,
do not bypass the reference, and do not relax correctness.

If a reviewer finds a repeated authority ambiguity, route it to owner
adjudication instead of looping on candidate code. The prior B200/MI300X mismatch
was resolved by owner-authorized metadata/default alignment; candidate code could
not honestly fix missing B200 hardware.

## Artifact Boundaries

In `kernel-harness-amd`:

- KDA-Pilot agents may make bounded commits when the round contract allows it.
- They must not push unless the owner explicitly requests it.
- They must not stage `.humanize/` state, caches, traces, binary build outputs,
  or scratch logs.
- Archive snapshots and knowledge entries are allowed only as finalization or
  owner-requested artifacts, with self-contained inputs and validators.

In this `omh-workflow` repository, the owner explicitly requested adding this
workflow package and pushing it.
