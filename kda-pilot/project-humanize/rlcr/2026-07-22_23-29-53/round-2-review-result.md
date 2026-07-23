# Round 2 Review Result

Mainline Progress Verdict: ADVANCED

## Review Summary

Claude did complete the kernel-facing Round-2 objective. I verified the corrected
review boundary (`3ddb2ea..HEAD`) contains only two candidate files, with the
Round-2 code delta limited to `testbench/tasks/glm52/moe_total_prefill/candidate.py`.
The new `_pick_group_size_m()` branch is exactly the claimed `M >= 4096 -> 16`
shift, with `BLOCK_SIZE_K` untouched.

The persisted gate artifacts support the MoE recovery claim:

| Task / artifact | Result |
|---|---|
| `kda_round2_moe_decode_official_r10a.json` | 2/2 wins, `shapes_regressed=0`, min_cons `1.0411`, `calc_diff=0` |
| `kda_round2_moe_decode_official_r10b.json` | 2/2 wins, `shapes_regressed=0`, min_cons `1.0454`, `calc_diff=0` |
| `kda_round2_moe_prefill_official_r10a.json` | 3/3 wins, `shapes_regressed=0`, min_cons `1.0058`, `calc_diff=0` |
| `kda_round2_moe_prefill_official_r10b.json` | 3/3 wins, `shapes_regressed=0`, min_cons `1.0038`, `calc_diff=0` |
| `kda_round2_dsa_prefill_attn_official_r10.json` | 3/3 wins, geomean `2.1213`, min_cons `2.0691`, worst `calc_diff=2.8842527531880435e-06` |
| `kda_round2_index_score_prefill_official_r10.json` | 3/3 wins, geomean `2.8416`, min_cons `1.5321`, `calc_diff=0` |

I also verified `selftest.py` passes, `sync_glm52_tasks.py --check` passes, the
taskset still names `rocm / amd-mi300x / aiter-torch-reference / event`, the
official metrics are unchanged, and there is no Round-2-boundary diff to
`glm52_ops.py`, task metadata, taskset files, runner/timing/reward code, or
generated `run.sh` files.

Clean closure is still blocked by one process requirement: the repo guide requires
one append-only `testbench/knowledge` entry per completed optimization session, and
no new entry was added for the Round-2 MoE tail-shape recovery. The `.humanize`
BitLesson entry is useful, but it is not a substitute for the harness knowledge
base.

Goal Alignment Summary:
`ACs: 5/5 addressed, 4/5 fully met | Forgotten items: 1 | Unjustified deferrals: 0`

## Mainline Gaps

No kernel-performance mainline gap remains. The accepted MoE win profile is restored
under the runnable pinned-CK reference, and the final four-task result has no lost
accepted wins and no shape regressions.

Task10/finalization is incomplete because the required knowledge-base entry is
missing; I classify that below as a blocking side issue for clean session closure
rather than as a kernel implementation failure.

## Blocking Side Issues

1. **Missing required `testbench/knowledge` entry blocks clean closure.**

   Evidence:
   - `testbench/knowledge/README.md` requires one structured entry per completed
     optimization session.
   - `find testbench/knowledge/entries` shows no new Round-2 entry after the
     existing `20260722a` GLM52 entries.
   - `git diff 3ddb2ea..HEAD -- testbench/knowledge` is empty.
   - The new lesson exists only in `.humanize/bitlesson.md`.

   Required implementation plan:
   1. Draft one new JSON entry, suggested id
      `glm52--moe_total_prefill--mi300x--20260723a`, for the Round-2 committed
      `moe_total_prefill` tail-shape recovery.
   2. Use only persisted `result.json` facts. For the final result fields, use one
      of the committed-candidate official prefill gates, for example
      `/opt/devmachine/lichangye/tmp/kda_round2_moe_prefill_official_r10b.json`:
      geomean `1.0459`, min_cons `1.0038`, repeat `10`, `shapes_won=3`,
      `shapes_regressed=0`.
   3. In `approaches`, record the `GROUP_SIZE_M` sweep:
      `GM=1/8` regressed, `GM=2/4` neutral, `GM=16/32` won, and the committed
      winner was `GM=16` for `M>=4096` because it restored the official full sweep
      without changing `BLOCK_SIZE_K` or `calc_diff`.
   4. Include the decode `BLOCK_SIZE_M` sweep as preservation/context evidence in
      the entry text or caveats: current `BM=32` already won, so no decode code
      change was made.
   5. Install with `python3 testbench/bin/knowledge.py add <draft.json>`, then run
      `python3 testbench/bin/knowledge.py lint`.
   6. Update `round-2-summary.md` and the tracker to cite the installed entry, then
      mark task10 complete again.

## Queued Side Issues

- **`AITER_TRITON_ONLY=0` remains manual provenance, not encoded state.**

  External aiter is correctly restored at HEAD `2ca7878e2d47`, CK
  `b6759456103a6e78137ecbae673c69865884f7e3`, and `module_quant.so` is present.
  But sourcing `/home/lichangye/rocm_env.sh` currently yields
  `AITER_TRITON_ONLY=1`. This does not invalidate the successful artifacts, but
  future MoE gates must explicitly export `AITER_TRITON_ONLY=0` until the owner
  fixes the default env or result schema.

- **Non-MoE task `run.sh` wrappers still select the wrong Python on this machine.**

  `dsa_prefill_attn/run.sh` and `index_score_prefill/run.sh` ignore
  `ROCM_TORCH_VENV` and fall back to `/opt/conda/bin/python3` when repo `.venv` is
  absent; that Python has CUDA torch and no ROCm. The Round-2 dsa/index artifacts
  are still valid because they were generated with the ROCm Python through
  `evaluate_task.py`/taskset-equivalent invocation and their candidate hashes match
  the committed files. This is an infrastructure follow-up, not a reason to change
  generated task files in this round.

## Goal Tracker Update

I updated the mutable section of
`.humanize/rlcr/2026-07-22_23-29-53/goal-tracker.md`:

- Plan Version is now 3, documenting that kernel wins are verified but clean
  closure needs the missing knowledge entry.
- `task10` is reopened as `needs revision`.
- Added a blocking side issue for the missing Round-2 `testbench/knowledge` entry.
- Corrected the `AITER_TRITON_ONLY` queued issue to reflect that the sourced env
  still defaults to `1`.
- Added the non-MoE `run.sh` Python-selection issue as queued.

Do not stop the loop yet: the kernel objective advanced, but finalization is not
complete until the required knowledge entry is added and validated.
