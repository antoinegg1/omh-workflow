# Round 2 Contract

## Mainline Objective (exactly one)

Restore **MoE accepted-win preservation** under the now-runnable pinned-CK
reference, using only the candidate-local, bit-exact scheduling levers already
established in the two MoE candidates. Concretely, regain `shape_verdict == win`
on the two shapes that softened to `neutral` in Round 1:

- `moe_total_decode` **M=32** (official sweep `[16, 32]`; M16 still wins) — lever:
  `BLOCK_SIZE_M` (leave `BLOCK_SIZE_K` untouched).
- `moe_total_prefill` **M=4096** (official sweep `[1024, 2048, 4096]`; M1024/M2048
  still win) — lever: `GROUP_SIZE_M` on both gemm configs (leave `BLOCK_SIZE_K`
  untouched).

Reference is FIXED for this round: `AITER_TRITON_ONLY=0`, aiter HEAD `2ca7878e2`,
CK pinned `b67594561`, current `module_quant.so`. **Do not degrade the reference,
loosen correctness, edit harness/task metadata, or touch frozen authority.** The
change, if any, must be confined to the two MoE `candidate.py` files.

If — after an honest sweep of the allowed levers — the tail shapes **cannot** be
returned to `win` without regressing another shape or changing numerics, the round
outcome is a **documented no-go**: keep the candidates correct with
`shapes_regressed == 0`, present the sweep evidence, and record a **Goal Tracker
Update Request** asking the owner to either accept the softened MoE tails (plan
revision) or keep task9 open. Never fabricate a win, and never "fix" the margin by
slowing/degrading the reference.

## Target ACs (1–2)

- **AC-2** — accepted wins are not lost: primary target. `moe_total_decode` returns
  to 2/2 wins and `moe_total_prefill` to 3/3 wins, with `shapes_regressed == 0` and
  `calc_diff == 0` on every official shape; the other three official tasks
  (dsa, index_score, and the non-tail MoE shapes) do not regress.
- **AC-3** — maximize under constraints: recover `min_primary_util_ratio_conservative`
  and `shapes_won` on both MoE tasks toward/above the accepted baseline
  (decode min_cons 1.0518 / shapes_won 2; prefill min_cons 1.0263 / shapes_won 3).

## Truly Blocking Issues (in scope — they block the mainline)

- **MoE tail-shape margin recovery** (from goal-tracker Blocking Side Issues,
  discovered Round-1 review): decode M32 (`cons 0.9938`) and prefill M4096
  (`cons 0.9714`) sit at reference parity under the restored reference. This is the
  single mainline blocker. Resolution = candidate-local bit-exact scheduling sweep
  for those two shapes only:
  - decode M32: sweep `BLOCK_SIZE_M ∈ {16, 32, 64, 128}` on the
    `_fused_moe_kernel_sequence` path; probe `run.sh --M 32 --repeat 3
    --iterations 30 --warmup 3`, gate the best with `--repeat 10`.
  - prefill M4096: sweep `GROUP_SIZE_M ∈ {1, 2, 4, 8, 16, 32}` on both gemm
    configs; probe `run.sh --M 4096 --repeat 3 --iterations 30 --warmup 3`, gate
    the best with `--repeat 10`.
  - Verify calc_diff == 0 for any chosen config; verify the full official sweep
    keeps `shapes_regressed == 0` and the non-tail shapes stay `win`.

## Queued Issues (explicitly OUT of scope this round)

- **Review-boundary / diff-base correction** (Codex queued): the Round-1 summary
  named `5efb3cf..HEAD`, which wrongly includes archive commits `ebfadea`/`3ddb2ea`.
  The correct candidate-local Round-2 boundary is **`3ddb2ea..HEAD`** (equivalently
  `fork/codex/amd-glm52-rocm-evalbench-v2..HEAD`). Documentation fix in the final
  report; not code.
- **AITER_TRITON_ONLY not in result JSON schema** (Codex queued): keep recording the
  exact env command/provenance in the summary; do not change the harness output
  schema (out of authority).
- **dsa / index_score further optimization**: at their established ceilings; only a
  final no-regression re-confirmation is in scope.

## Concrete Success Criteria

**Win recovery (preferred):**
- `moe_total_decode`: official sweep `[16, 32]` both `shape_verdict == win`,
  `shapes_won == 2`, `shapes_regressed == 0`, `calc_diff == 0`, `min_cons ≥ ~1.05`
  (toward accepted 1.0518), gated at `--repeat 10 --iterations 30 --warmup 3`.
- `moe_total_prefill`: official sweep `[1024, 2048, 4096]` all `win`,
  `shapes_won == 3`, `shapes_regressed == 0`, `calc_diff == 0`, `min_cons ≥ ~1.02`
  (toward accepted 1.0263), gated at `--repeat 10`.
- Four-task official check re-run (all four, `--repeat 10 --iterations 30
  --warmup 3`): no accepted win lost anywhere; dsa ~2.12 and index_score ~2.84 hold.
- Change confined to the two MoE `candidate.py`; repo otherwise clean;
  `round-2-summary.md` reports honest full completion with per-shape evidence.

**Documented no-go (only if the levers cannot recover the win):**
- Full sweep evidence for both tail shapes (every probed config, per-shape cand/ref
  latency, ratio, cons, calc_diff) showing no bit-exact config beats the restored
  reference beyond the noise band.
- MoE candidates left correct (`shapes_regressed == 0`, calc_diff 0), other tasks
  unregressed.
- `round-2-summary.md` = **blocked / complete-with-caveats**, plus a **Goal Tracker
  Update Request** for owner adjudication (accept softened MoE tails, or keep task9
  open). No completion claim without owner authorization.
