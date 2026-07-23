# Round 0 Review Result

Mainline Progress Verdict: ADVANCED

## Review Summary

Claude made a real mainline advance on `dsa_prefill_attn`: the committed candidate
hash matches the persisted run, the full M=1024/2048/4096 sweep is correct, and the
aggregate improves `geomean_primary_util_ratio` from the accepted baseline
`1.3044` to `2.1181` with `shapes_regressed == 0`.

However, the round is not complete under the original plan. `moe_total_decode` and
`moe_total_prefill` remain deferred/blocked, and the original plan requires a final
official-task check for all four targets. The summary's "CLEAN success" wording is
therefore not acceptable as a final completion claim.

Goal Alignment Summary:
`ACs: 5/5 addressed | Forgotten items: 0 | Unjustified deferrals: 1`

The MoE environment blocker is real, but treating the MoE deferral as compatible
with clean completion is the unjustified part. AC-2 and AC-4 remain blocked for
MoE until the authoritative gates run again.

## Mainline Gaps

1. **Clean completion is invalid because the required four-task final check is incomplete.**

   The original plan's task9 requires a final official-task check for
   `moe_total_decode`, `moe_total_prefill`, `dsa_prefill_attn`, and
   `index_score_prefill`; AC-4 also says unavailable authoritative gates must end
   as blocked/complete-with-caveats, not clean complete. The persisted MoE runs are
   still `INCORRECT` before timing: `runs/glm52/moe_total_decode/20260723T014412Z-2dab28/result.json`
   fails with `[aiter] build [module_quant] ... failed`, and
   `runs/glm52/moe_total_prefill/20260723T014735Z-89fcd4/result.json` fails the
   same way. Those runs have null aggregate metrics and cannot prove
   `shapes_regressed == 0` for the MoE official tasks.

   Required next implementation plan:
   1. Restore the MoE reference environment before touching candidates:
      source `/home/lichangye/rocm_env.sh`, export `AITER_TRITON_ONLY=0`, ensure
      `$AITER_ROOT/3rdparty/composable_kernel` is populated, and ensure aiter can
      build or load `aiter/jit/module_quant*.so`.
   2. If modifying `/mnt/public/lichangye/rocm-env/repos/aiter` is outside Claude's
      authority, stop and keep the goal blocked; do not bypass the reference,
      loosen correctness, or rewrite harness code.
   3. Once the environment is restored, run gate-quality checks for both MoE
      official tasks using the original candidates:
      `"$ROCM_TORCH_VENV/bin/python" testbench/bin/evaluate_glm52_taskset.py --taskset tasksets/glm52_rocm_local.json --task moe_total_decode --repeat 10 --iterations 30 --warmup 3 --json-out /opt/devmachine/lichangye/tmp/kda_round2_moe_total_decode_recheck.json`
      and the same command for `moe_total_prefill`.
   4. Compare each MoE result against the accepted baseline table and require
      `correct == true`, complete sweep, and `shapes_regressed == 0`.
   5. Re-run or retain the already-valid dsa/index_score gates, then run the
      four-task official check loop from the original plan.
   6. Revise `round-0-summary.md` to report either full completion with all four
      tasks verified, or blocked/complete-with-caveats if the MoE gate remains
      unavailable.

2. **The round contract narrowed scope away from the original plan.**

   `round-0-contract.md` allows clean success on only `dsa_prefill_attn` and/or
   `index_score_prefill`, while the original plan optimizes under constraints
   across four official metrics and explicitly keeps all four accepted targets
   protected. This scope change explains the dsa progress, but it does not satisfy
   the original task breakdown's task9/task10 completion requirements. I updated
   the mutable goal tracker to mark task9 as `blocked` and task10 as `needs
   revision`.

## Blocking Side Issues

- **Incomplete aiter/MoE environment blocks AC-2 and AC-4 for MoE.**

  Evidence is consistent across artifacts: `AITER_TRITON_ONLY=1` hits
  `gemm_a16w16_asm` import failures, and `AITER_TRITON_ONLY=0` reaches
  `module_quant` JIT build failure. The aiter checkout has an empty
  `3rdparty/composable_kernel` directory, and no `module_quant*.so` was found
  under `aiter/jit`. This blocks authoritative MoE correctness and performance
  measurement; it is not a candidate-local kernel issue.

## Queued Side Issues

- **Environment evidence gap:** the dsa result JSON records the ROCm backend and
  candidate hash, but it does not record `AITER_TRITON_ONLY`. Since the summary
  says `AITER_TRITON_ONLY=0` is mandatory to avoid a degraded reference, future
  gate artifacts should capture that variable or include the exact command log.
  This does not invalidate the dsa run by itself, but it weakens reproducibility.

- **Review-boundary ambiguity:** if the review boundary is only `3ddb2ea..HEAD`,
  the reviewable diff is candidate-local. If the boundary is the whole listed
  development history since `f60a697`, the branch also contains archive binaries,
  generated task metadata churn, and harness changes that would need explicit
  owner authorization under AC-5. Claude should state the intended diff base in
  the final report.

## Verified Positives

- `python3 testbench/bin/selftest.py` passed: `26 tasks, 0 problems`.
- `sync_glm52_tasks.py --check` passed: `24 task dirs are in sync with glm52_ops`.
- Current branch is `codex/amd-glm52-rocm-evalbench-v2`.
- `dsa_prefill_attn` run `20260723T025835Z-4fc839` is gate-quality
  (`repeat=10`, `iterations=30`, `warmup=3`), correct, post-timing correct, and
  has `shapes_won=3`, `shapes_regressed=0`.
- `index_score_prefill` run `20260723T030353Z-0284e0` preserves the accepted win
  with `geomean_primary_util_ratio=2.8361`, `calc_diff=0`, and
  `shapes_regressed=0`.

## Goal Tracker Update

I updated the mutable section of
`.humanize/rlcr/2026-07-22_23-29-53/goal-tracker.md`:

- Added a Round 0 review plan-evolution row rejecting clean completion.
- Changed task9 from `completed` to `blocked`.
- Changed task10 from `completed` to `needs revision`.

Do not stop the loop yet: deferred MoE work remains incomplete.
