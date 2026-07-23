# Round 3 Review Result

Mainline Progress Verdict: ADVANCED

## Review Summary

Claude did make the intended data-only mainline advance: the missing
`testbench/knowledge` entry exists at
`testbench/knowledge/entries/glm52--moe_total_prefill--mi300x--20260723a.json`,
`knowledge.py lint` passes, and `knowledge.py query --task glm52/moe_total_prefill
--gpu MI300X` returns the new entry newest-first.

The entry's core provenance checks out. The source artifact
`/opt/devmachine/lichangye/tmp/kda_round2_moe_prefill_official_r10b.json` exists,
its `candidate.sha256` is
`221718a3bb122f1e86e15acac805dd0f69a047d379c5af28f804fabd0cb167c6`, and that
matches the committed `testbench/tasks/glm52/moe_total_prefill/candidate.py`.
The entry result fields match the persisted aggregate: geomean `1.0459`,
min conservative `1.0038`, repeat `10`, `shapes_won=3`,
`shapes_regressed=0`, and `worst_calc_diff=0.0`.

Clean closure is still blocked by a Round-3 contract miss. The contract's
definition of done explicitly required `knowledge.py index --check` and
`knowledge.py distill --check` to be green, regenerated if needed. Claude's
summary instead justifies leaving those generated tracked files stale. That
contradicts the round's own DoD and leaves task10/finalization incomplete.

Goal Alignment Summary:
`ACs: 5/5 addressed, 4/5 fully met | Forgotten items: 0 | Unjustified deferrals: 1`

## Mainline Gaps

1. **Round-3 definition of done is not satisfied: generated KB freshness checks still fail.**

   Evidence:
   - `python3 testbench/bin/knowledge.py lint` passes: `17 entries, 0 problems`.
   - `python3 testbench/bin/knowledge.py query --task glm52/moe_total_prefill --gpu MI300X`
     returns `glm52--moe_total_prefill--mi300x--20260723a` with
     `[win geo=1.0459 minc=1.0038]`.
   - `python3 testbench/bin/knowledge.py index --check` fails with 3 stale
     tracked files:
     `testbench/knowledge/queries/by-op.md`,
     `testbench/knowledge/queries/by-bottleneck.md`, and
     `testbench/knowledge/queries/by-technique.md`.
   - `python3 testbench/bin/knowledge.py distill --check` fails with stale
     `testbench/knowledge/distilled.json` and
     `testbench/knowledge/distilled.md`.
   - Those five generated outputs are tracked by git, so this is not ignored
     cache churn.
   - `round-3-contract.md` says task16 must "regenerate KB indices if a
     `--check` gate would otherwise flag them stale" and the definition of done
     says both `index --check` and `distill --check` must be green.

   Claude's "add-only" rationale may explain why the diff is smaller, but it is
   an explicit deferral of a contract requirement. It cannot be treated as clean
   completion.

   Required implementation plan:
   1. Do not change kernel candidates, task metadata, tasksets, harness scoring,
      timing, references, or existing `testbench/knowledge/entries/*.json` files.
   2. From the current HEAD, run:
      `python3 testbench/bin/knowledge.py index`
   3. Run:
      `python3 testbench/bin/knowledge.py distill`
   4. Review the resulting tracked diffs and keep them limited to:
      `testbench/knowledge/queries/by-op.md`,
      `testbench/knowledge/queries/by-bottleneck.md`,
      `testbench/knowledge/queries/by-technique.md`,
      `testbench/knowledge/distilled.json`, and
      `testbench/knowledge/distilled.md`.
   5. Verify all knowledge checks:
      `python3 testbench/bin/knowledge.py lint`,
      `python3 testbench/bin/knowledge.py query --task glm52/moe_total_prefill --gpu MI300X`,
      `python3 testbench/bin/knowledge.py index --check`, and
      `python3 testbench/bin/knowledge.py distill --check`.
   6. Commit the generated KB updates with a `knowledge:`-scoped message. The
      commit must not include `.humanize/`, scratch artifacts, caches, traces,
      binaries, or any kernel/harness/task authority changes.
   7. Update the current round summary/tracker after the validators are green.
      Do not claim clean completion until all four commands above pass.

## Blocking Side Issues

No separate kernel or correctness blocker was found in Round 3. The blocking
issue is the mainline finalization gap above: tracked generated KB outputs remain
stale even though the round contract required them to be refreshed or checked
green.

## Queued Side Issues

- `AITER_TRITON_ONLY=0` remains manual provenance rather than result-schema state.
  This is still non-blocking for Round 3 because no new GPU gate was run and the
  knowledge entry cites the persisted artifact plus matching candidate hash.

- The non-MoE task `run.sh` wrappers still select the wrong Python on this machine
  when repo `.venv` is absent. This remains an infrastructure follow-up and must
  not take over the knowledge-finalization round.

## Goal Tracker Update

The mutable tracker already reflects this review outcome: Plan Version 5 reopens
task10/task16, records the stale generated KB files as an open blocking side
issue, and gives the same regeneration/verification path. I made no further
tracker edit.

Do not stop the loop yet: the required knowledge entry was installed correctly,
but the Round-3 generated-KB freshness checks are still failing.
