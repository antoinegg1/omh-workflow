# Round 1 Review Result

Mainline Progress Verdict: ADVANCED

## Review Summary

Claude made a real mainline advance: the aiter reference environment is no longer
unavailable. I verified the external aiter checkout at HEAD `2ca7878e2d47`, the
`3rdparty/composable_kernel` submodule at pinned commit `b6759456103a6e78137ecbae673c69865884f7e3`,
and `aiter/jit/module_quant.so` present at 2,848,344 bytes. The MoE gates now run
and the persisted results are correct with `calc_diff == 0` and
`shapes_regressed == 0`.

That is not enough to close the original plan. The plan and Round-1 contract both
require the final four-task check to ensure no accepted win was lost. Under the
restored pinned-CK reference, both MoE tasks lost one accepted winning shape:
`moe_total_decode` drops from 2/2 wins to 1/2, and `moe_total_prefill` drops from
3/3 wins to 2/3. Calling those shapes "neutral" is accurate for the harness
regression gate, but it does not satisfy the plan's separate accepted-win
preservation requirement.

Goal Alignment Summary:
`ACs: 5/5 addressed, 4/5 fully met | Forgotten items: 0 | Unjustified deferrals: 0`

AC-2 remains incomplete for MoE accepted-win preservation. AC-4 advanced because
the unavailable authoritative gate is now runnable and honestly evidenced.

## Mainline Gaps

1. **Task9 is still incomplete: the restored MoE gates lost accepted wins.**

   Evidence from the accepted baseline vs Round-1 single-task rechecks:

   | Task | Accepted baseline | Round-1 restored env | Lost condition |
   |------|-------------------|----------------------|----------------|
   | `moe_total_decode` | geomean `1.0655`, cons geomean `1.0532`, min_cons `1.0518`, `shapes_won=2` | geomean `1.055`, cons geomean `1.0139`, min_cons `0.9938`, `shapes_won=1` | M32 moved win -> neutral |
   | `moe_total_prefill` | geomean `1.0809`, cons geomean `1.0587`, min_cons `1.0263`, `shapes_won=3` | geomean `1.0406`, cons geomean `1.0212`, min_cons `0.9714`, `shapes_won=2` | M4096 moved win -> neutral |

   The original plan says "Existing accepted wins are not lost" and task9 says
   "Run a final official-task check for all four targets and ensure no accepted win
   was lost." Round-1 contract repeats the same constraint: MoE gates must have
   `shapes_regressed == 0` **and no lost accepted win**, and clean completion
   requires ratios >= the accepted baseline or at least not regressed. The current
   result satisfies correctness and harness no-regression, but not accepted-win
   preservation.

   Required next implementation plan:

   1. Keep the restored reference environment fixed: `AITER_TRITON_ONLY=0`, aiter
      HEAD `2ca7878e2d47`, CK pinned at `b67594561`, and the current
      `module_quant.so`. Do not degrade the reference, loosen correctness, or edit
      harness/task metadata.
   2. Make `moe_total_decode` M32 and `moe_total_prefill` M4096 the only mainline
      blockers. The dsa and index_score results are already sufficient and should
      only be rechecked at the end.
   3. Warm-start each MoE task with `python3 testbench/bin/brief.py <task>` and
      use only the known bit-exact scheduling levers already established in the
      candidates: decode `BLOCK_SIZE_M`, prefill `GROUP_SIZE_M`. Leave
      `BLOCK_SIZE_K` untouched.
   4. Create scratch candidates outside the task dirs and sweep decode M32 with
      `BLOCK_SIZE_M` values `{16, 32, 64, 128}` for the existing `_fused_moe_kernel_sequence`
      path. Probe with `testbench/tasks/glm52/moe_total_decode/run.sh --candidate
      <scratch.py> --M 32 --repeat 3 --iterations 30 --warmup 3`, then gate the
      best variant with `--repeat 10`.
   5. Sweep prefill M4096 with `GROUP_SIZE_M` values `{1, 2, 4, 8, 16, 32}` applied
      to both gemm configs. Probe with
      `testbench/tasks/glm52/moe_total_prefill/run.sh --candidate <scratch.py>
      --M 4096 --repeat 3 --iterations 30 --warmup 3`, then gate the best variant
      with `--repeat 10`.
   6. Commit only candidate-local changes that restore the neutral tail shape to
      `shape_verdict=win`, keep `calc_diff == 0`, and keep `shapes_regressed == 0`
      on the full task sweep.
   7. Re-run the four official tasks with `--repeat 10 --iterations 30 --warmup 3`.
      Do not claim completion unless MoE accepted-win preservation is restored or
      the owner explicitly revises the plan to allow the softened MoE tails.

2. **The Round-1 completion claim is premature.**

   "Complete with caveats" is acceptable when a gate is unavailable or when a
   caveat does not block an AC. Here the gate is available, and the caveat is
   exactly the task9/AC-2 condition the plan asked Claude to protect. The summary
   must be revised after the MoE tail-shape work above.

## Blocking Side Issues

- **Goal tracker drift was present; I corrected it.**

  The tracker had task9/task10/task12 marked complete and the MoE deferral closed.
  I updated the mutable section so task11 remains complete, task9 is blocked,
  task10 needs revision, task12 is partial, and the active blocking issue is MoE
  accepted-win preservation under the restored reference.

## Queued Side Issues

- **Review-boundary statement is still wrong.**

  Round-1 summary says the intended candidate-local boundary is `5efb3cf..HEAD`.
  That range includes archive commits `ebfadea` and `3ddb2ea` plus many `archive/**`
  binaries. The actual candidate-local Round-2 diff is `3ddb2ea..HEAD` or
  `fork/codex/amd-glm52-rocm-evalbench-v2..HEAD`, which is only
  `testbench/tasks/glm52/dsa_prefill_attn/candidate.py`.

- **AITER_TRITON_ONLY remains outside result JSON.**

  This does not invalidate the current MoE evidence because the env was documented
  and the restored reference was directly verified, but final reporting should keep
  the exact env command/provenance until the schema captures it.

## Verified Positives

- `python3 testbench/bin/selftest.py` passes: `26 tasks, 0 problems`.
- `sync_glm52_tasks.py --check` passes in the no-GPU structural path:
  `24 task dirs are in sync with glm52_ops`.
- External aiter env restoration matches the claim: aiter HEAD `2ca7878e2d47`, CK
  submodule `b6759456103a6e78137ecbae673c69865884f7e3`, `module_quant.so` present.
- MoE authoritative rechecks are gate-quality (`repeat=10`, `iterations=30`,
  `warmup=3`), correct, complete sweeps, and have `shapes_regressed == 0`.
- `dsa_prefill_attn` remains a real improvement over accepted baseline:
  geomean ratio `1.3044 -> 2.1181`, `shapes_regressed=0`.
- `index_score_prefill` remains effectively preserved within noise:
  geomean ratio `2.8371 -> 2.8361`, min_cons `1.5375 -> 1.5382`,
  `shapes_regressed=0`.

Do not stop the loop yet: the MoE gate is now available, but the final
no-lost-accepted-win condition is still open.
