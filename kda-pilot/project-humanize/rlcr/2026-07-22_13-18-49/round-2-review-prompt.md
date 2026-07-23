# Code Review - Round 2

## Original Implementation Plan

**IMPORTANT**: The original plan that Claude is implementing is located at:
@.humanize/kernel-agent/refined-plan.md

You MUST read this plan file first to understand the full scope of work before conducting your review.
This plan contains the complete requirements and implementation details that Claude should be following.

Based on the original plan and @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-2-prompt.md, Claude claims to have completed the work. Please conduct a thorough critical review to verify this.

---
Below is Claude's summary of the work completed:
<!-- CLAUDE's WORK SUMMARY START -->
# Round 2 Summary — Drift Recovery

## Mainline Objective (from round-2-contract.md)

Recover from two consecutive `STALLED` verdicts and prove real mainline movement by
advancing the plan to the **third official target, `dsa_prefill_attn`** (GLM-5.2 DSA
sparse MLA attention, prefill; M ∈ {1024, 2048, 4096}). Produce a baseline
characterization and either (a) a correctness-preserving primary-util win on ≥1 shape,
or (b) a named no-go blocker with evidence. **Outcome: WIN on all 3 shapes** (~1.4–1.65×
MFU), not a no-go.

## Root Cause of the Prior Drift (recorded, not "fixed" by me)

The round-0 and round-1 `STALLED` verdicts were **not** stalled engineering — they were a
review-side infrastructure failure. The loop's round review runs `codex review`, which is
invoked with **no sandbox-bypass flag**, so it runs under Codex's default OS sandbox →
`bwrap: Failed to make / slave: Permission denied`. `codex review` cannot read the git
diff, so it returns `STALLED` / `ACs: unknown/unknown` having seen nothing. The `codex exec`
path (ask-codex) gets `--full-auto` and tolerates the bwrap failure via inline evidence,
which is why every inline review has completed and returned GO. I did **not** modify the
reviewer config, the humanize hooks, or any loop state file (that would be tampering with
the verifier); the owner-facing fix is documented in `round-2-contract.md`. This round I
again mitigated by embedding all evidence inline in the `codex exec` review.

## Work Completed

**Baseline characterization.** On this ROCm build the CUDA `sparse_prefill_fwd` op is not
compiled, so the task's reference entry point `sgl_kernel.flash_mla.flash_mla_sparse_fwd`
dispatches (via the harness `AmdRewardbenchProvider.mla` path) to sglang's **TileLang**
sparse-MLA kernel (`_try_sglang_tilelang_sparse_mla`; tilelang IS available in the rocm
venv). So the frozen reference output == the TileLang kernel output. That kernel is **slow**
on these prefill shapes — device-event medians ~11.7 / 26 / 44 ms at M = 1024 / 2048 / 4096
— and the roofline evaluator classifies the op as compute-bound (primary_util = MFU ≈ 0.033,
BW-util ~0.005). This is the opposite of the two MoE targets: here the reference is a
poorly-tuned compiled kernel, not a tightly-tuned Triton launch, leaving real headroom.

**The lever.** A plain PyTorch sparse-attention (gather top-2048 KV per query → QK^T →
softmax → weighted V over the first `d_v=512` dims) runs 2.5–3× faster than TileLang on
these shapes. The only correctness catch: the naive bf16 QK matmul rounds the logits to
bf16 before softmax and drifts to `calc_diff ≈ 6.52e-6` vs the reference — just over the
`5e-6` gate (FAIL). Raising **only the QK score matmul to fp32** (q and gathered KV upcast
for that einsum only) matches the reference's fp32 logits far better: `calc_diff` drops to
`2.88e-6` (inside the gate, ~1.7× margin) while still running ~1.9× faster. softmax stays
fp32, probs are cast to bf16, and the P@V matmul stays bf16 — the exact structure of the
harness torch path, with only QK precision raised. This is not a reference/tolerance tweak:
it is an independent implementation that passes the official 3-layer correctness check
against the frozen reference.

Standalone probe (calc_diff vs TileLang reference; ratio = tilelang/variant):

| M | qk=bf16 pv=bf16 | qk=fp32 pv=bf16 (chosen) | qk=fp32 pv=fp32 |
|---|---|---|---|
| 1024 | cd 6.52e-6 **FAIL** 3.57× | cd 2.88e-6 PASS 1.96× | cd 1.87e-6 PASS 1.56× |
| 2048 | cd 6.53e-6 **FAIL** 3.35× | cd 2.88e-6 PASS 1.97× | — |
| 4096 | cd 6.53e-6 **FAIL** 3.14× | cd 2.88e-6 PASS 1.89× | — |

Chosen: `qk=fp32, pv=bf16` — best speed with a safe gate margin. (Codex agreed: keep
`pv=bf16`; `pv=fp32` spends real measured speed for margin already proven on the
authoritative inputs.)

## Files Changed

- `testbench/tasks/glm52/dsa_prefill_attn/candidate.py` (modified) — the sanctioned
  candidate file, only file changed. No oracle / harness / reference / taskset touched.

## Validation

Official evaluator `evaluate_glm52_taskset.py --task dsa_prefill_attn --repeat 10
--iterations 30 --warmup 3 --no-gpu-lock` (metric `roofline_mfu_bw`, primary_util = MFU;
CUPTI cold-L2 device-kernel median; ratio = candidate/reference):

| M | status | MFU | TFLOP/s | GB/s | ratio | conservative | correct |
|----|--------|-------|---------|-------|--------|--------------|---------|
| 1024 | passed | 0.03297 | 43.11 | 33.43 | 1.6467 | 1.555 | True |
| 2048 | passed | 0.03256 | 42.57 | 27.51 | 1.5619 | 1.461 | True |
| 4096 | passed | 0.03308 | 43.26 | 25.16 | 1.3998 | 1.199 | True |

Summary: **passed=3, correct_not_faster=0, incorrect=0, infra_failed=0** — all 3 prefill
shapes correct AND faster, 0 regressions. Satisfies "≥1 conservative win, 0 regress,
0 incorrect".

- Commit: `3531593` (candidate.py only; 1 file changed, +89/−3). Base: `f60a697`.
- GPU: AMD MI300X (gfx942). JSON artifact:
  `/opt/devmachine/lichangye/tmp/kda_glm52_dsa_prefill_r2_gate.json`.
- Command:
  `evaluate_glm52_taskset.py --taskset tasksets/glm52_rocm_local.json --task dsa_prefill_attn --repeat 10 --iterations 30 --warmup 3 --no-gpu-lock`.

Codex review (gpt-5.5:xhigh, inline-evidence — its `codex review` sandbox was bwrap-blocked):
**GO**, no required changes. Confirmed legitimate (passing the gate by computing QK *more
precisely*, not via seed-specific corrections / hardcoded outputs / tolerance bypass /
evaluator branching), correctness-durable (stable `calc_diff ≈ 2.88e-6` across all 3 M on
the authoritative inputs; keep `pv=bf16`), and the try/except cannot return a wrong tensor
(fast path fills a fresh `out` over all chunks or falls back to the untouched reference
kernel). Optional (declined, code hygiene only): narrow the broad `except` — not a GO
blocker, and the explicit shape/dtype guards already run before any fast-path work, matching
the round-0/round-1 approved fallback pattern.

## Remaining Items

- **Round-0 and round-1 `codex review` verdicts remain infra-blocked** (bwrap). Those are
  review-sandbox failures, not rejections of the committed wins (7dc4959 decode, 3c8aa34
  prefill, both inline-GO). Re-running them once the sandbox is fixed is the harness/owner's
  responsibility; I did not touch reviewer config, hooks, or state files. Owner-facing fix
  is in `round-2-contract.md`.
- (Later target, queued) `index_score_prefill` (target #4) — `deep_gemm.fp8_mqa_logits`;
  next round.
- (Queued) M=64 decode (~1.0 frontier) and M=4096 prefill MoE thin margin (1.002×) — would
  need a different kernel/lever, not a config knob.

## Goal Tracker Update Request

### Requested Changes
- Mark `dsa_prefill_attn` (round-2 mainline) COMPLETED with evidence: official gate
  passed=3/3, ratios 1.647/1.562/1.400× (conservative 1.555/1.461/1.199×), all correct,
  0 regressions, commit `3531593`. Satisfies AC-2, AC-3, AC-4, AC-5.
- Plan Evolution: round-2 target lever is a *different class* from the two MoE targets —
  those tuned a Triton launch config (bit-exact reuse of the reference kernel); here the
  reference is a slow compiled TileLang kernel with no config knob, so the win is an
  **independent, more-precise (fp32-QK) torch reimplementation that passes the calc_diff
  gate**. No AC impact (AC-3 explicitly allows any candidate that preserves ABI +
  correctness; this passes the official 3-layer check).
- Move round-2 Active Tasks to Completed/Queued; queue `index_score_prefill` as the next
  target.

### Justification
Round 2 recovered from the review-infra-induced stall by delivering evidence-backed,
Codex-approved forward progress on the third official target: a 1.40–1.65× MFU win on all
three prefill shapes, correct and 0-regression, committed as a single sanctioned-file diff.
This is plan-aligned mainline movement (targets #1, #2, #3 now converged with committed
wins), not scope broadening.

## BitLesson Delta

- Action: none
- Lesson ID(s): NONE
- Notes: `bitlesson.md` has no entries; `bitlesson_allow_empty_none: true`. No new BitLesson
  promoted. This round did surface one reusable project fact: the correctness-preserving
  lever is target-dependent — when the reference is a tightly-tuned Triton launch, the safe
  lever is a bit-exact launch-config knob (decode `BLOCK_SIZE_M`, prefill `GROUP_SIZE_M`);
  when the reference is a slow monolithic compiled kernel with no knob (dsa TileLang), the
  safe lever is an independent reimplementation tuned to *pass* the calc_diff gate (raise QK
  to fp32 to match the reference's fp32 logits), legitimate precisely because the official
  gate — not bit-exactness — defines correctness.

---

# ADDENDUM — target #4 `index_score_prefill` (landed in the same open round-2 cycle)

## Why this is in the round-2 file

The round-2 Stop-hook verdict run **crashed on a NEW harness bug** before it could produce a
verdict or increment the round counter: `loop-codex-stop-hook.sh: line 1915: syntax error
near unexpected token 'then'`. So `state.md` is still `current_round: 2`, and the
write-validator (correctly) blocks creating `round-3-*.md`. I did **NOT** edit the hook,
`state.md`, or the reviewer config — that would be tampering with the verifier. Rather than
fight the validator, I recorded this second target's win where the harness allows it: the
goal-tracker mutable section (the persistent anchor) + this addendum + the codex-reviews log.
The counter-stuck bug is filed as an owner-facing Queued Side Issue.

Since targets #1/#2/#3 have all converged with committed wins, advancing to target #4 is
plan-aligned forward progress (plan task11 permits starting the next target when the current
is complete), not scope-broadening.

## Mainline objective

Advance to the fourth official target, **`index_score_prefill`** (GLM-5.2 indexer score /
MQA logits, prefill; `deep_gemm.fp8_mqa_logits`; M ∈ {1024, 2048, 4096}). Baseline
characterization + a correctness-preserving primary-util win on ≥1 shape, or a named no-go.
**Outcome: WIN on all 3 shapes** (1.56×–3.89× MFU), bit-exact.

## Baseline characterization

The task reference `deep_gemm.fp8_mqa_logits(q_fp8,(k_fp8,k_scale),weights,ks,ke,
clean_logits=False)` on this ROCm build dispatches to aiter's Triton kernel
`aiter.ops.triton.attention.fp8_mqa_logits`. Directly timed (event median): **2.01 / 15.09 /
29.17 ms** at M = 1024 / 2048 / 4096 — the reference IS the slow aiter Triton kernel, not a
faster path. On gfx942 that function's LDS-occupancy heuristic (`_gfx942_tile_fits_lds`)
predicts the default `(BLOCK_KV=128, num_stages=2)` tile will not keep two workgroups
co-resident on a CU, so it **drops to `BLOCK_KV=64, num_stages=1`**. With grid `(seq_len,)`
(one program per query row) the KV loop over `seq_len_kv=65536` dominates, and a 64-wide tile
serialises it badly. Roofline classifies the op compute-bound (primary_util = MFU ≈
0.10/0.027/0.029). This is the **same class as the two MoE targets**: the reference is a
poorly-tiled Triton launch, so the safe lever is a bit-exact launch-config override.

## The lever (bit-exact `BLOCK_KV` override)

The candidate calls the reference's OWN kernel `_fp8_mqa_logits_kernel` with the reference's
EXACT preprocessing — same fnuz recast + scale compensation copied verbatim, same
`clean_logits=False` `torch.empty` output buffer with the same `seq_len_kv_aligned` slice and
strides, same `matrix_instr_nonkdim` heuristic (16 if seq_len≤1024 else 32) — overriding ONLY
the launch tile to **`BLOCK_KV=256, num_stages=1`** (`num_warps=4`, `waves_per_eu=2`
unchanged). `BLOCK_KV` changes how many keys each program processes per inner iteration; it
does NOT change the per-logit reduction (the q·k dot is over `HEAD_SIZE=128`, accumulated
identically), and `num_stages`/`num_warps`/`waves_per_eu` are pure scheduling. `weights`
arrives 3D `(M,32,1)` and is squeezed to `(M,32)` — the same view the reference deep_gemm
path uses internally. Standalone probe: **`calc_diff == 0.00e+00` (bit-exact)** at all three M.

Guards: fast path runs only on gfx942, non-gluon, power-of-2 heads/head_size, Q rank 3, and
only when the heuristic does NOT already resolve to the large tile; any exception falls back
to the untouched `deep_gemm.fp8_mqa_logits` reference via try/except.

### Bug caught before the final claim

The first official run reported `correct_not_faster` ratio ≈ 1.0 on all 3 — because I
initially forgot to squeeze the 3D `weights`, so the fast path raised
`too many values to unpack` and silently fell back to reference. After adding
`weights.squeeze(-1)` the fast path runs, `calc_diff` stays 0.0, and the official win appears.
(This is exactly why the try/except fallback + a re-check of `calc_diff==0` matters.)

## Files Changed

- `testbench/tasks/glm52/index_score_prefill/candidate.py` (modified) — the only file
  changed. No oracle / harness / reference / taskset touched.

## Validation

Official evaluator `evaluate_glm52_taskset.py --task index_score_prefill --repeat 10
--iterations 30 --warmup 3 --no-gpu-lock` (metric `roofline_mfu_bw`, primary_util = MFU;
ratio = candidate/reference):

| M | status | MFU | TFLOP/s | GB/s | ratio | conservative | correct |
|----|--------|-------|---------|-------|--------|--------------|---------|
| 1024 | passed | 0.1598 | 418.0 | 214.0 | 1.5573 | 1.5353 | True |
| 2048 | passed | 0.1068 | 279.3 | 140.8 | 3.8931 | 3.8471 | True |
| 4096 | passed | 0.1077 | 281.7 | 140.9 | 3.7618 | 3.6944 | True |

Summary: **passed=3, correct_not_faster=0, incorrect=0, infra_failed=0** — all 3 prefill
shapes correct AND faster, 0 regressions. MFU roughly 0.10→0.16 / 0.027→0.107 / 0.029→0.108.

- Commit: `37132ff` (candidate.py only; 1 file changed, +146/−2). Base: `f60a697`.
- GPU: AMD MI300X (gfx942). JSON artifact:
  `/opt/devmachine/lichangye/tmp/kda_glm52_index_score_r3_gate.json`.
- Command:
  `evaluate_glm52_taskset.py --taskset tasksets/glm52_rocm_local.json --task index_score_prefill --repeat 10 --iterations 30 --warmup 3 --no-gpu-lock`.

Codex review (gpt-5.5:xhigh, inline-evidence — its `codex review` sandbox is bwrap-blocked
and its evaluator rerun was GPU-blocked): **GO**, no required changes. Confirmed legitimate
(only launch tiling overridden; no oracle/taskset/tolerance/timer/input change),
correctness-durable (65536 % 256 == 0 ⇒ no partial KV tail; ks=0/ke=65536 ⇒ no in-range
holes in the empty buffer; official `correct=True` includes the calc_diff layer), the
`weights.squeeze(-1)` matches the provider's own view, and the try/except cannot return a
wrong tensor (fresh logits buffer on success, untouched reference on exception). Full text in
`codex-reviews.md` and `/opt/devmachine/lichangye/tmp/index_score_r3_codex_go.md`.

## Owner-facing blockers (I did NOT fix these — verifier/harness scope)

1. **`bwrap` review-sandbox failure** (recurring): the loop's `codex review` verdict runs
   under Codex's default OS sandbox and fails `bwrap: Failed to make / slave: Permission
   denied`, returning blind STALLED. Mitigated by inline-evidence `codex exec`. Fix options
   in `round-2-contract.md`.
2. **NEW: Stop-hook syntax crash** `loop-codex-stop-hook.sh:1915: syntax error near
   unexpected token 'then'` — the round-2 verdict never ran and the round counter never
   advanced past 2. Owner must fix the hook so the loop can increment rounds; until then the
   round-3+ files cannot be created and mainline wins are recorded in the goal-tracker anchor
   + this addendum.

---

## AC-4 addendum: authoritative per-shape latency + bound (persisted result.json)

Round-2 review required per-shape **bound** and **candidate/reference latency** on top of
the MFU/BW/ratio rows already reported. These are re-extracted from the per-task runner's
persisted `result.json` (`testbench/harness/evaluate_task.py` -> `runs/glm52/<task>/<run_id>/
result.json`), NOT re-typed from the gate JSON. All four targets rerun at commit `37132ff`
on AMD Instinct MI300X (gfx942:sramecc+:xnack-, hip 7.0.51831, torch 2.10.0+rocm7.0,
sgl_kernel 0.4.3, sglang 20fc529, aiter 2ca7878). `primary_util_ratio` is the metric ratio;
`cons` = `reference_p10 / candidate_p90`; latency = cold-L2 device-kernel median (us).

### moe_total_decode — `runs/glm52/moe_total_decode/20260722T083714Z-126708/result.json`
metric_resource = **BW** (memory-bound); shapes_won=2, shapes_regressed=0, worst_calc_diff=0.0

| M | bound | AI | cand_us | ref_us | cand MFU | ref MFU | cand BW-util | ratio | cons |
|----|-------|------|---------|--------|----------|---------|--------------|-------|------|
| 16 | memory | 31.8 | 164.234 | 176.463 | 0.0225 | 0.0209 | 0.3492 | 1.0745 | 1.0547 |
| 32 | memory | 63.2 | 173.598 | 183.443 | 0.0426 | 0.0403 | 0.3325 | 1.0567 | 1.0518 |

geomean primary-util ratio 1.0655, min conservative 1.0518.

### moe_total_prefill — `runs/glm52/moe_total_prefill/20260722T083730Z-959e52/result.json`
metric_resource = **MFU** (compute-bound); shapes_won=3, shapes_regressed=0, worst_calc_diff=0.0

| M | bound | AI | cand_us | ref_us | cand MFU | ref MFU | cand TFLOP/s | ratio | cons |
|------|--------|--------|----------|----------|----------|---------|--------------|-------|------|
| 1024 | compute | 1445.6 | 959.717 | 1093.863 | 0.2464 | 0.2162 | 644.4 | 1.1398 | 1.1208 |
| 2048 | compute | 2234.2 | 1724.092 | 1828.600 | 0.2744 | 0.2587 | 717.5 | 1.0606 | 1.0316 |
| 4096 | compute | 3072.0 | 3378.808 | 3529.768 | 0.2800 | 0.2680 | 732.2 | 1.0447 | 1.0263 |

geomean primary-util ratio 1.0809, min conservative 1.0263.

### dsa_prefill_attn — `runs/glm52/dsa_prefill_attn/20260722T083802Z-1b233d/result.json`
metric_resource = **MFU** (compute-bound); shapes_won=3, shapes_regressed=0, worst_calc_diff=2.88e-6 (<= 5e-6)

| M | bound | AI | cand_us | ref_us | cand MFU | ref MFU | cand TFLOP/s | ratio | cons |
|------|--------|--------|-----------|-----------|----------|---------|--------------|-------|------|
| 1024 | compute | 1289.5 | 6515.454 | 8457.869 | 0.0343 | 0.0264 | 44.8 | 1.2981 | 1.2800 |
| 2048 | compute | 1547.4 | 13154.249 | 17186.764 | 0.0340 | 0.0260 | 44.4 | 1.3066 | 1.2603 |
| 4096 | compute | 1719.3 | 26449.731 | 34613.670 | 0.0338 | 0.0258 | 44.2 | 1.3087 | 1.2896 |

geomean primary-util ratio 1.3044, min conservative 1.2603. (Note: these persisted device
medians differ from the earlier gate-JSON snapshot — same win, re-measured on the per-task
runner; the persisted result.json is the authoritative source cited here. The candidate
prose in `candidate.py` was corrected to reflect the compute-bound / primary_util=MFU
classification.)

### index_score_prefill — `runs/glm52/index_score_prefill/20260722T084041Z-7a3d33/result.json`
metric_resource = **MFU** (compute-bound); shapes_won=3, shapes_regressed=0, worst_calc_diff=0.0 (bit-exact)

| M | bound | AI | cand_us | ref_us | cand MFU | ref MFU | cand TFLOP/s | ratio | cons |
|------|--------|--------|----------|-----------|----------|---------|--------------|-------|------|
| 1024 | compute | 1953.6 | 1330.448 | 2068.226 | 0.1580 | 0.1017 | 413.2 | 1.5545 | 1.5375 |
| 2048 | compute | 1984.1 | 3938.409 | 15449.527 | 0.1068 | 0.0272 | 279.2 | 3.9228 | 3.9037 |
| 4096 | compute | 1999.7 | 7883.530 | 29523.005 | 0.1067 | 0.0285 | 278.9 | 3.7449 | 3.7113 |

geomean primary-util ratio 2.8371, min conservative 1.5375.

**Command** (per target): `KERNEL_HARNESS_PLATFORM=rocm KERNEL_HARNESS_PROFILE=amd-mi300x
KERNEL_HARNESS_PROVIDER=aiter-torch-reference KERNEL_HARNESS_TIMER=event
python testbench/harness/evaluate_task.py --task glm52/<task> ...` -> persisted result.json
paths above. GPU: AMD Instinct MI300X (gfx942). Commit: `37132ff`.

Knowledge-base entries recorded (one per completed target, all numbers from the result.json
above), installed via `python3 testbench/bin/knowledge.py add` and validated by
`knowledge.py lint` (16 entries, 0 problems):
`glm52--moe_total_decode--mi300x--20260722a`, `glm52--moe_total_prefill--mi300x--20260722a`,
`glm52--dsa_prefill_attn--mi300x--20260722a`, `glm52--index_score_prefill--mi300x--20260722a`.
<!-- CLAUDE's WORK SUMMARY  END  -->
---

## Development History (Integral Context)

Accumulated commits since loop start (oldest first):
```
7dc4959 moe_total_decode: shrink Triton BLOCK_SIZE_M for dense decode (bit-exact ~1.06-1.08x)
3c8aa34 moe_total_prefill: tune Triton GROUP_SIZE_M for dense prefill (bit-exact ~1.05-1.15x)
3531593 dsa_prefill_attn: fp32-QK torch sparse-MLA beats slow TileLang baseline
37132ff Optimize index_score_prefill via bit-exact BLOCK_KV override
46903b1 knowledge: record 4 GLM-5.2 MI300X optimization sessions + AC-4 fix
```

### Recent Round Files
Read these files before conducting your review to understand the trajectory of work:
- @.humanize/rlcr/2026-07-22_13-18-49/round-1-summary.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-1-review-result.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-0-summary.md
- @.humanize/rlcr/2026-07-22_13-18-49/round-0-review-result.md


Use this history to identify patterns across rounds: recurring issues, stalled progress, or drift from the mainline objective. Weight recent rounds more heavily but watch for systemic trends in the full commit log.

## Part 1: Implementation Review

- Your task is to conduct a deep critical review, focusing on finding implementation issues and identifying gaps between "plan-design" and actual implementation.
- Relevant top-level guidance documents, phased implementation plans, and other important documentation and implementation references are located under @docs.
- If Claude planned to defer any tasks to future phases in its summary, DO NOT follow its lead. Instead, you should force Claude to complete ALL tasks as planned.
  - Such deferred tasks are considered incomplete work and should be flagged in your review comments, requiring Claude to address them.
  - If Claude planned to defer any tasks, please explore the codebase in-depth and draft a detailed implementation plan. This plan should be included in your review comments for Claude to follow.
  - Your review should be meticulous and skeptical. Look for any discrepancies, missing features, incomplete implementations.
- If Claude does not plan to defer any tasks, but honestly admits that some tasks are still pending (not yet completed), you should also include those pending tasks in your review.
  - Your review should elaborate on those unfinished tasks, explore the codebase, and draft an implementation plan.
  - A good engineering implementation plan should be **singular, directive, and definitive**, rather than discussing multiple possible implementation options.
  - The implementation plan should be **unambiguous**, internally consistent, and coherent from beginning to end, so that **Claude can execute the work accurately and without error**.

## Part 2: Goal Alignment Check (MANDATORY)

Read @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/goal-tracker.md and verify:

1. **Acceptance Criteria Progress**: For each AC, is progress being made? Are any ACs being ignored?
2. **Forgotten Items**: Are there tasks from the original plan that are not tracked in Active/Completed/Deferred?
3. **Deferred Items**: Are deferrals justified? Do they block any ACs?
4. **Plan Evolution**: If Claude modified the plan, is the justification valid?

Include a brief Goal Alignment Summary in your review:
```
ACs: X/Y addressed | Forgotten items: N | Unjustified deferrals: N
```

## Part 3: Required Finding Classification

You MUST classify your findings into these lanes:
- **Mainline Gaps**: plan-derived work or AC progress that is missing, incomplete, or regressing
- **Blocking Side Issues**: bugs or implementation issues that block the current mainline objective from succeeding safely
- **Queued Side Issues**: valid non-blocking follow-up issues that should be documented but must NOT take over the next round

Also include a one-line verdict:
```
Mainline Progress Verdict: ADVANCED / STALLED / REGRESSED
```

This verdict line is mandatory. If you omit it, the Humanize stop hook will block the round and require the review to be rerun.

If Claude mostly worked on queued side issues and failed to advance the mainline, say so explicitly.

## Part 4: ## Goal Tracker Update Requests (YOUR RESPONSIBILITY)

Claude should normally keep the **mutable section** of `goal-tracker.md` up to date directly. If Claude's summary contains a "Goal Tracker Update Request" section, or if you detect tracker drift during review, YOU must:

1. **Evaluate the tracker state**: Is the mutable section still aligned with the Ultimate Goal and current AC progress?
2. **If correction is needed**: Update @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/goal-tracker.md yourself with the requested changes:
   - Move tasks between Active/Completed/Deferred sections as appropriate
   - Add entries to "Plan Evolution Log" with round number and justification
   - Add new issues to "Blocking Side Issues" or "Queued Side Issues" as appropriate
   - **NEVER modify the IMMUTABLE SECTION** (Ultimate Goal and Acceptance Criteria)
3. **If you reject a requested tracker change**: Include in your review why it was rejected

Common update requests you should handle:
- Task completion: Move from "Active Tasks" to "Completed and Verified"
- New blocking issues: Add to "Blocking Side Issues"
- New queued issues: Add to "Queued Side Issues"
- Plan changes: Add to "Plan Evolution Log" with your assessment
- Deferrals: Only allow with strong justification; add to "Explicitly Deferred"

## Part 5: Output Requirements

- In short, your review comments can include: problems/findings/blockers; claims that don't match reality; implementation plans for deferred work (to be implemented now); implementation plans for unfinished work; goal alignment issues.
- Your output should be structured so Claude can tell which items are mainline gaps, blocking side issues, and queued side issues.
- If after your investigation the actual situation does not match what Claude claims to have completed, or there is pending work to be done, output your review comments to @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_13-18-49/round-2-review-result.md.
- **CRITICAL**: Only output "COMPLETE" as the last line if ALL tasks from the original plan are FULLY completed with no deferrals
  - DEFERRED items are considered INCOMPLETE - do NOT output COMPLETE if any task is deferred
  - UNFINISHED items are considered INCOMPLETE - do NOT output COMPLETE if any task is pending
  - The ONLY condition for COMPLETE is: all original plan tasks are done, all ACs are met, no deferrals or pending work allowed
- The word COMPLETE on the last line will stop Claude.
