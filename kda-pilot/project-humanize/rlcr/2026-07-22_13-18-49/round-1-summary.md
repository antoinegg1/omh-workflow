# Round 1 Summary

## Mainline Objective (from round-1-contract.md)

Attempt a correctness-preserving speedup on the next official target,
`moe_total_prefill` (GLM-5.2 fused MoE, prefill phase, AMD MI300X / ROCm gfx942,
fp8_e4m3 w8a8; prefill_M ∈ {1024, 2048, 4096}). **Outcome: WIN on all 3 shapes.**

## Work Completed

Round 0 established (and this round reconfirmed) that no fp8 reimplementation can
pass the `calc_diff ≤ 5e-6` gate (fp8 saturation cliff), so the only correctness-safe
lever is to drive the reference's OWN Triton kernels with a numerically-identical but
faster launch config.

Baseline characterization showed **prefill is compute-bound** (evaluator
`primary_util == mfu` at every shape; bw_util tiny 0.04–0.08), and the reference MFU
was only ~0.18–0.23 — so the round-0 decode lever (shrink `BLOCK_SIZE_M` to kill
dense-decode padding) does NOT transfer: at M ∈ {1024,2048,4096} the block padding is
already negligible.

A bit-exact config sweep (holding `BLOCK_SIZE_K` fixed; sweeping `BLOCK_SIZE_N`,
`GROUP_SIZE_M`, `num_warps`, `num_stages`) found the dominant lever is **`GROUP_SIZE_M`**:
the resolver (`try_get_optimal_moe_config`) returns `GROUP_SIZE_M=32` for all three
prefill M, but that L2-swizzle grouping is too coarse for the dense fused-MoE grid.
`GROUP_SIZE_M` only reorders which (m,n) output tile each Triton program computes for
L2 locality — it never changes the per-output-element fp32 K-accumulation (that is
`BLOCK_SIZE_K`) — so overriding it is **bit-exact** (`calc_diff == 0.00e+00` verified
at every M and every swept value). A focused confirm sweep (3 repeated 60-iter medians)
gave the per-M winners:

| M | resolver default | tuned | device-kernel ratio_vs_default | calc_diff |
|---|---|---|---|---|
| 1024 | GM=32 | GM=1 | 1.146× | 0.00e+00 |
| 2048 | GM=32 | GM=4 | 1.057× | 0.00e+00 |
| 4096 | GM=32 | GM=4 | 1.020× | 0.00e+00 |

(`GM=1,BN=128` regresses to 0.956× at M=4096, so only `GROUP_SIZE_M` is touched — never
`BLOCK_SIZE_N`.) The candidate reuses the resolver's config, overrides only
`GROUP_SIZE_M` (1 for M≤1024, else 4) on both gemm1 and down configs, recomputes
`moe_align_block_size` with the UNCHANGED `BLOCK_SIZE_M`, and calls sglang's own
`_fused_moe_kernel_sequence`. A no-op guard raises → reference fallback if the resolver
already picked the target `GROUP_SIZE_M`; `run()` wraps the fast path in try/except →
untouched reference on any surprise.

## Files Changed

- `testbench/tasks/glm52/moe_total_prefill/candidate.py` (modified) — the sanctioned
  candidate file, only file changed. No oracle / harness / reference / taskset touched.

## Validation

Official evaluator `evaluate_glm52_taskset.py --task moe_total_prefill --repeat 10
--iterations 30 --warmup 3` (metric `roofline_mfu_bw`, primary_util = MFU;
CUPTI cold-L2 device-kernel median; ratio = candidate/reference):

| M | status | MFU | TFLOP/s | GB/s | ratio | conservative | correct |
|----|--------|-------|---------|-------|--------|--------------|---------|
| 1024 | passed | 0.2463 | 644.2 | 445.6 | 1.1474 | 1.0634 | True |
| 2048 | passed | 0.2704 | 706.9 | 316.4 | 1.0553 | 1.0046 | True |
| 4096 | passed | 0.2787 | 728.9 | 237.3 | 1.0460 | 1.0021 | True |

Summary: **passed=3, correct_not_faster=0, incorrect=0, infra_failed=0** — all 3 prefill
shapes correct AND faster, 0 regressions. Satisfies "≥1 conservative win, 0 regress,
0 incorrect".

- Commit: `3c8aa34` (candidate.py only; 1 file changed). Base: `f60a697`.
- GPU: AMD MI300X (gfx942). JSON artifact:
  `/opt/devmachine/lichangye/tmp/kda_glm52_moe_total_prefill_r1_prefill_gate.json`.
- Command:
  `evaluate_glm52_taskset.py --taskset tasksets/glm52_rocm_local.json --task moe_total_prefill --repeat 10 --iterations 30 --warmup 3 --no-gpu-lock`.

Codex review (gpt-5.5:xhigh, inline-evidence — its sandbox was `bwrap`-blocked):
**GO**, no required changes. Confirmed legitimate launch-config optimization (not a
reward hack — reference kernels/fp8 path/scales/routing/BLOCK_SIZE_M/N/K/warps/stages
all unchanged, only GROUP_SIZE_M), correctness-durable (GROUP_SIZE_M is program-id/L2
swizzle, not K-reduction; calc_diff==0.0 + official correctness at all 3 M is strong
evidence), and the try/except can only mask exceptions by returning the oracle output,
never a wrong fast-path tensor. Optional (declined): M-whitelist — the GROUP_SIZE_M
change is bit-exact for any M, so a whitelist would only add brittleness.

## Remaining Items

- **Round-0 Codex review was infra-blocked** (`bwrap: Failed to make / slave: Permission
  denied`; Codex could not read any files → STALLED). That is a review-sandbox failure,
  NOT a rejection of the committed round-0 win (7dc4959, 5/6 decode shapes + tie). I
  mitigated the recurrence this round by embedding ALL evidence inline in the ask-codex
  prompt, which let Codex complete a real review and return GO. Re-running the round-0
  review remains the loop harness's responsibility; I did not touch state files.
- (Later targets, queued) `dsa_prefill_attn`, `index_score_prefill`.
- (Queued) M=64 decode (~1.0 frontier) and M=4096 prefill thin margin (1.002× conservative,
  still positive) — would need a different kernel/lever, not a config knob, to widen.

## Goal Tracker Update Request

### Requested Changes
- Mark `moe_total_prefill` (round-1 mainline) COMPLETED with evidence: official gate
  passed=3/3, ratios 1.147/1.055/1.046× (conservative 1.063/1.005/1.002×), all correct,
  0 regressions, commit `3c8aa34`. Satisfies AC-2, AC-3, AC-4, AC-5.
- Mark round-0 `moe_total_decode` win (commit 7dc4959) as completed-pending-review:
  its Codex verification was infra-blocked (bwrap), not rejected.
- Add to Queued Side Issues: Codex sandbox `bwrap` filesystem failure blocks
  review-side file reads (mitigated by inline-evidence prompts; harness-side fix needed).
- Plan Evolution: round-1 target lever differs from round-0 — decode used `BLOCK_SIZE_M`
  shrink (padding removal), prefill uses `GROUP_SIZE_M` L2-swizzle tuning
  (compute-bound). No AC impact.

### Justification
Round 1 completed the plan's second-priority official target with an evidence-backed,
Codex-approved, bit-exact MFU win on all three shapes, advancing the Ultimate Goal
(optimize GLM-5.2 operators under the frozen roofline_mfu_bw authority). The mutable
Active-Tasks table still reflected round-0 task IDs; these updates reconcile it.

## BitLesson Delta

- Action: none
- Lesson ID(s): NONE
- Notes: bitlesson.md has no entries; `bitlesson_allow_empty_none: true`. No new
  BitLesson promoted. This round reinforced two existing project facts (already in
  memory): (1) the fp8-saturation correctness barrier forces bit-exact reuse of the
  reference Triton kernels, and (2) the correctness-preserving lever is a launch-config
  knob that leaves BLOCK_SIZE_K (K-accumulation) untouched — for compute-bound prefill
  that knob is GROUP_SIZE_M (L2 swizzle), distinct from decode's BLOCK_SIZE_M.
