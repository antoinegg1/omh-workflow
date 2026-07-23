# Code Review - Round 0

## Original Implementation Plan

**IMPORTANT**: The original plan that Claude is implementing is located at:
@.humanize/kernel-agent/refined-plan-round2-no-regression-maximize.md

You MUST read this plan file first to understand the full scope of work before conducting your review.
This plan contains the complete requirements and implementation details that Claude should be following.

Based on the original plan and @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-0-prompt.md, Claude claims to have completed the work. Please conduct a thorough critical review to verify this.

---
Below is Claude's summary of the work completed:
<!-- CLAUDE's WORK SUMMARY START -->
# Round 0 Summary

**Outcome: CLEAN success** (per round-0 contract) on the #1-priority official task
`dsa_prefill_attn`, with the #2 task `index_score_prefill` re-verified and its
accepted win preserved. Both MoE official tasks are reported **blocked
(environment)**, never clean complete — consistent with AC-4 and the contract.

---

## What Was Implemented

A single, correctness-preserving, no-regression speedup to the **QK score matmul**
of `dsa_prefill_attn` (the chunked torch sparse-attention candidate). The QK matmul
was ~60% of kernel runtime and ran as an **fp32 einsum** on bf16 inputs upcast to
fp32 — correct, but with **no MFMA** (~40 TFLOP/s), because torch exposes no
bf16-in/fp32-out GEMM (a plain bf16 `bmm` rounds the logits to bf16 → calc_diff
drifts to ~6.5e-6, over the 5e-6 gate).

The fix routes QK through aiter's tuned `batched_gemm_bf16` while passing a
**caller-preallocated fp32 `YQ`** output tensor:

- `dtype=torch.bfloat16` is passed **only** to satisfy the wrapper's
  `assert dtype in [bf16, fp16]`; the kernel writes to `YQ`'s pointer, so the true
  output dtype is `YQ.dtype` = **fp32**.
- bf16×bf16 products are exact in fp32, so the logits are **bit-identical** to the
  fp32 einsum apart from fp32 accumulation-order noise (~1e-14 rel).
- Result: **MFMA throughput at unchanged precision** — calc_diff stays 2.884e-6
  (identical to baseline), while MFU rises 0.034 → 0.055 and the whole kernel
  speeds up ~1.62x.

Three guardrails are baked into `candidate.py` (do not remove):
1. **Import-time probe** `_probe_aiter_fp32_yq()` verifies the dtype=bf16+fp32-YQ
   path actually writes fp32 (rel < 1e-4 vs einsum) before enabling; disables the
   fast path on any mismatch.
2. `_qk_scores()` **falls back to the fp32 einsum** (never a bf16 path) on any
   exception.
3. **No env mutation and no probe inside `run()`** — import/probe happen at module
   load, outside the timed region.

## Files Changed

| File | Change | Notes |
|------|--------|-------|
| `testbench/tasks/glm52/dsa_prefill_attn/candidate.py` | 140 → 222 lines | Added guarded aiter QK GEMM helper `_qk_scores()`, import-time fp32-write probe `_probe_aiter_fp32_yq()`, and fp32-einsum fallback. In-loop call changed to `scores = _qk_scores(q_chunk, gathered, sm_scale)`. `run()` still wraps `_fast_sparse_mla_prefill` in try/except → `flash_mla_sparse_fwd` reference fallback. sha256 `7698920ecb28617b7c9d0762a8f3cfee487b3a866fab1fb43512a5e51966c733`. |

No other repo files changed. Frozen authority untouched (taskset, official_metrics,
correctness thresholds, reference functions, cost model, device peaks, timing
semantics, deployment metadata). Branch unchanged
(`codex/amd-glm52-rocm-evalbench-v2`). `.humanize/`, traces, caches, and scratch
logs are excluded from the reviewable diff (AC-5).

## Validation

All gate runs use the authoritative harness
(`testbench/harness/evaluate_task.py`), full sweep M=1024/2048/4096, `--repeat 10`,
cold-L2, conservative q=0.9, under **`AITER_TRITON_ONLY=0`** (required or the
sglang TileLang reference silently degrades to a bf16 fallback). Baseline
(fp32-QK einsum @ git HEAD) and new candidate were run **sequentially in the same
session** to avoid GPU timing contention.

### `dsa_prefill_attn` — per-shape (persisted run `20260723T025835Z-4fc839`)

| Shape | cand µs | ref µs | MFU | primary-util ratio | conservative ratio | calc_diff |
|-------|---------|--------|-----|--------------------|--------------------|-----------|
| M=1024 | 4008.7 | 8432.0 | 0.0557 | 2.103 | 2.063 | 2.8837e-6 |
| M=2048 | 8068.2 | 17100.1 | 0.0554 | 2.119 | 2.096 | 2.8843e-6 |
| M=4096 | 16201.1 | 34535.0 | 0.0552 | 2.132 | 2.122 | 2.8833e-6 |

**Aggregate:** geomean_primary_util_ratio **2.1181**, geomean_cons **2.0935**,
min_cons **2.0626**, shapes_won **3**, shapes_regressed **0**, timing_unstable
False, post_timing_correct True.

### `dsa_prefill_attn` — baseline vs new (Δ against accepted baseline table)

| Metric | Accepted baseline | New | Δ |
|--------|-------------------|-----|---|
| geomean_primary_util_ratio | 1.3044 | **2.1181** | +62% |
| min_primary_util_ratio_conservative | 1.2603 | **2.0626** | +64% |
| geomean MFU | 0.034010 | **0.0552** | +62% |
| worst calc_diff | 2.8842e-6 | 2.8843e-6 | **unchanged** (margin 1.73x under 5e-6) |
| shapes_regressed | — | **0** | no regression |

### `index_score_prefill` — accepted win preserved (untouched, re-gated)

| Metric | Accepted baseline | Re-gate | Status |
|--------|-------------------|---------|--------|
| geomean_primary_util_ratio | 2.8371 | 2.8361 | within noise |
| min_primary_util_ratio_conservative | 1.5375 | 1.5382 | within noise |
| calc_diff | 0 | 0 | CORRECT |
| shapes_regressed | — | 0 | preserved |

No candidate edit; the small deltas are run-to-run timing noise, not regression.

### Advance decision (why no further dsa iteration)

New per-256-chunk component profile at M=1024 (`/tmp/prof_new.py`): gather **303µs**
(memory-bound, ~114µs HBM floor), QK-aiter **438µs** (MFMA-bound, fp32 output is the
floor; was ~975µs), softmax **122µs** (fp32, precision-locked), PV **212µs** (already
bf16→bf16 MFMA). The only MFMA-headroom lever (QK) is now closed; remaining
components have no clean low-risk lever. → **advance**, not iterate.

## Remaining Items

- **`moe_total_decode` / `moe_total_prefill` — BLOCKED (environment), not clean
  complete.** The restored env's aiter is incomplete: `module_quant.so` absent +
  CK submodule `3rdparty/composable_kernel` uninitialized (no `ck_tile` headers),
  so the fp8 MoE **reference** cannot run (`AITER_TRITON_ONLY=1` →
  `gemm_a16w16_asm` ImportError; `=0` → `module_quant` JIT build fails). The
  authoritative gate returns `incorrect` for both. Not fixable within frozen repo
  authority — needs the **env owner** to restore a prebuilt `module_quant*.so` or
  `git submodule update --init 3rdparty/composable_kernel` + rebuild (the latter
  risks numeric drift vs the accepted baseline). Round 0 routes around it: both MoE
  candidates left **untouched** so their accepted wins are preserved. Deferred in
  goal-tracker with revisit trigger = env restored.

- No other candidate-local dsa/index_score levers remain low-risk this round (see
  profile above and the `index_score` launch-config optimum established in task2).

## BitLesson Delta

Action: add
Lesson ID(s): BL-20260723-aiter-fp32yq-mfma-qk
Applied this round: NONE (KB was empty at round start — bitlesson-selector could
not run due to a transient Bedrock infra API error, but with an empty KB the
selection is deterministically NONE regardless).
Notes: This round solved a non-trivial, reusable problem — getting fp32-precision
matmul output at MFMA speed on MI300X via aiter `batched_gemm_bf16` + a
caller-preallocated fp32 `YQ`, when torch exposes no bf16-in/fp32-out GEMM. Added
one new entry to `.humanize/bitlesson.md` documenting the trigger (fp32-output
matmul stuck as a slow einsum for a correctness gate), the exact fix, the aiter
dtype/YQ-dtype contract fragility, the mandatory `AITER_TRITON_ONLY=0`, and the
reward-hack warning (never accept a bf16-QK candidate that scores calc_diff 0
against a degraded reference). Validation evidence recorded inline in the entry.
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
4597e91 dsa_prefill_attn: guard fp32-QK fast path to ROCm only (fix P1)
a7428ef dsa/index_score: anchor ROCm device guards to authoritative taskset
e01d123 glm52: align task metadata + harness defaults to ROCm/MI300X
baea0bc index_score_prefill: route ROCm fallback through harness reference (fix P1)
5efb3cf moe_total_{decode,prefill}: drop unused N from w1.shape unpack (finalize cleanup)
ebfadea archive lichangye GLM52 ROCm best candidates
3ddb2ea archive lichangye token perf plots
26bdb84 dsa_prefill_attn: route QK scores through aiter bf16 GEMM with fp32 output
```

### Recent Round Files
Read these files before conducting your review to understand the trajectory of work:
(first round, no prior history)

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

Read @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/goal-tracker.md and verify:

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
2. **If correction is needed**: Update @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/goal-tracker.md yourself with the requested changes:
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
- If after your investigation the actual situation does not match what Claude claims to have completed, or there is pending work to be done, output your review comments to @/home/lichangye/kernel-harness-amd/.humanize/rlcr/2026-07-22_23-29-53/round-0-review-result.md.
- **CRITICAL**: Only output "COMPLETE" as the last line if ALL tasks from the original plan are FULLY completed with no deferrals
  - DEFERRED items are considered INCOMPLETE - do NOT output COMPLETE if any task is deferred
  - UNFINISHED items are considered INCOMPLETE - do NOT output COMPLETE if any task is pending
  - The ONLY condition for COMPLETE is: all original plan tasks are done, all ACs are met, no deferrals or pending work allowed
- The word COMPLETE on the last line will stop Claude.
