# Round 0 Contract

## Mainline Objective (one)

Land at least one **correctness-preserving, no-regression** improvement to the
official `roofline_mfu_bw` outcome on a gate-runnable official task
(`dsa_prefill_attn` priority #1, `index_score_prefill` priority #2), **or** produce
documented no-go evidence for the plausible candidate-local directions on those two
tasks — while preserving every accepted first-loop win.

## Target ACs

- **AC-2** — correctness + no-regression are hard constraints.
- **AC-3** — maximize `geomean_primary_util_ratio` under those constraints.

(AC-1 preflight and AC-4 evidence are satisfied as guardrails throughout; AC-5
governs the final diff.)

## Blocking Side Issues In Scope

- None that I can resolve. The MoE-reference env blocker (incomplete aiter) is
  **acknowledged and routed around**, not fixed this round — it needs the env
  owner. Its consequence for scope: `moe_total_decode` and `moe_total_prefill`
  are not modifiable/verifiable this round; their accepted wins are preserved by
  leaving the candidates untouched.

## Queued Side Issues Out Of Scope

- `AITER_TRITON_ONLY=1` default and root-owned `/tmp/aiter_configs`: environment
  provisioning; the config-dir issue is already worked around, and the env var
  only matters for MoE (already blocked upstream). Not the round objective.

## Round Success Criteria

Round 0 is a **clean** success only if, on `dsa_prefill_attn` and/or
`index_score_prefill`:

- correctness passes pre- and post-timing on every evaluated shape, and
- `shapes_regressed == 0`, and
- at least one of `geomean_primary_util_ratio`,
  `geomean_primary_util_ratio_conservative`, `min_primary_util_ratio_conservative`,
  or `shapes_won` improves beyond the accepted baseline, backed by a
  `--repeat >= 10` gate-quality result JSON compared to the baseline table.

Otherwise Round 0 is a **complete-with-caveats** success if all plausible
candidate-local directions on those two tasks are documented as no-go with
per-shape evidence, and no accepted win was lost.

In **either** outcome, `moe_total_decode` / `moe_total_prefill` are reported as
**blocked (environment)**, never clean complete — consistent with AC-4.
