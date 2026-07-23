# Round 4 Review Result

Mainline Progress Verdict: ADVANCED

## Review Summary

Round 4 resolves the single Round-3 blocker. I verified that HEAD is
`7202073` on `codex/amd-glm52-rocm-evalbench-v2`, the commit is scoped to the five
generated knowledge files, and all four knowledge validators now pass:

- `python3 testbench/bin/knowledge.py lint` -> `17 entries, 0 problems`
- `python3 testbench/bin/knowledge.py query --task glm52/moe_total_prefill --gpu MI300X` -> returns `glm52--moe_total_prefill--mi300x--20260723a` newest-first
- `python3 testbench/bin/knowledge.py index --check` -> `0 stale`
- `python3 testbench/bin/knowledge.py distill --check` -> `up to date`

The Round-4 diff is exactly the generated bookkeeping claimed:

- `testbench/knowledge/queries/by-op.md`
- `testbench/knowledge/queries/by-bottleneck.md`
- `testbench/knowledge/queries/by-technique.md`
- `testbench/knowledge/distilled.json`
- `testbench/knowledge/distilled.md`

`git diff --numstat HEAD~1..HEAD` reports `+286/-2`, matching the summary. No
candidate, task metadata, taskset, harness oracle, timing, scoring, or existing
`entries/*.json` file changed in Round 4. The generated content is entry-derived:
`distilled.json` now has `generated_from_entries: 17`, the Round-3 entry appears
under `moe_total` in `by-op.md`, and its techniques appear in `by-technique.md`.

## Part 1: Goal Tracker Audit

| AC | Status | Evidence | Blocker | Justification if Deferred |
|----|--------|----------|---------|---------------------------|
| AC-1 | MET | Branch is `codex/amd-glm52-rocm-evalbench-v2`; `git status --short --untracked-files=all` is clean; taskset hardware is `rocm / amd-mi300x / aiter-torch-reference / event`; official metrics are exactly `dsa_prefill_attn`, `index_score_prefill`, `moe_total_prefill`, `moe_total_decode`; `selftest.py` -> `26 tasks, 0 problems`; `sync_glm52_tasks.py --check` -> `24 task dirs are in sync`. | None | N/A |
| AC-2 | MET | Persisted official artifacts show all four tasks correct with `shapes_regressed=0`: decode r10a/r10b `2/2`, prefill r10a/r10b `3/3`, dsa `3/3`, index_score `3/3`; worst calc_diff is `0.0` for MoE/index_score and `2.8842527531880435e-06` for dsa. Accepted wins are preserved. | None | N/A |
| AC-3 | MET | The loop improved official metrics under constraints: dsa geomean improved to `2.1213`; index_score held at `2.8416`; MoE decode and prefill accepted-win profiles were restored under the pinned-CK reference (`2/2` and `3/3`). | None | N/A |
| AC-4 | MET | Claimed performance facts are backed by persisted JSON artifacts under `/opt/devmachine/lichangye/tmp/kda_round2_*_official_r10*.json`; the Round-3 knowledge entry matches the committed candidate hash and final prefill artifact; Round 4 added only generated views from those entries. | None | N/A |
| AC-5 | MET | Final reviewable diff excludes `.humanize/`, scratch, traces, caches, binaries, and build outputs. Round-4 commit contains only generated KB files, and the knowledge entry plus generated query/distill files now satisfy the repo knowledge-base workflow. | None | N/A |

Forgotten items detection:

- No original plan task is missing from the tracker. Tasks 1-10 are represented,
  and the added tasks 11, 12, 14, 15, and 16 cover the later MoE/env/knowledge
  blockers introduced by review.
- No task is marked complete without supporting verification in the current
  tracker. The final task10/task16 rows now cite the green knowledge validators.
- The "Active Tasks" table is functioning as a mainline task ledger rather than a
  remaining-work list, but every listed row has status `completed`; there are no
  active remaining mainline tasks.

Deferred items audit:

- `Explicitly Deferred` contains `None currently`. This is correct. The earlier
  MoE gate availability deferral is closed, and the generated-KB freshness deferral
  from Round 3 was resolved in Round 4.

Goal completion summary:

```
Acceptance Criteria: 5/5 met (0 deferred)
Active Tasks: 0 remaining
Estimated remaining rounds: 0
Critical blockers: []
```

## Part 2: Mainline Drift Audit

The Round-4 mainline objective was clear and singular: regenerate the tracked
knowledge query/distill outputs so the Round-3 Definition of Done is actually met.
That objective directly serves AC-5/finalization rather than drifting into unrelated
cleanup.

Claude has been clearing review-discovered blockers in sequence, not cycling:
Round 0 advanced dsa but exposed MoE gate unavailability; Round 1 restored the MoE
reference environment but exposed accepted-win loss; Round 2 restored MoE wins;
Round 3 installed the required knowledge entry; Round 4 regenerated the required
generated KB views. Each review finding was addressed in the next round.

Blocking Side Issues: 0

Queued Side Issues: 2

- `AITER_TRITON_ONLY=0` remains manual provenance rather than result-schema state.
- Non-MoE task `run.sh` wrappers still select the wrong Python when repo `.venv`
  is absent.

These are queued infrastructure issues, not blockers for the original plan's final
state. They do not contradict the Ultimate Goal because the final evidence is
persisted, taskset-driven, and already documents the required environment.

## Part 3: Implementation Review

No implementation defect found in Round 4. The commit message has no AI-authorship
trailer, the change is `knowledge:` scoped, and `git show --name-status HEAD`
contains only the five generated files. `git diff 1a315c6..HEAD -- testbench/harness
tasksets testbench/tasks/glm52 testbench/knowledge` shows only the same five
knowledge-generated files; no frozen authority changed.

The generated files are not arbitrary churn. `knowledge.py index --check` and
`knowledge.py distill --check` are now green, and `rg` confirms the Round-3 entry
and its three techniques are visible in the generated query/distill outputs.
This is exactly the remediation required by the Round-3 review.

The four-task performance state was not re-run in Round 4, which is acceptable
because no kernel or authority code changed. The persisted Round-2 official
artifacts remain present and support the final AC-2/AC-4 claims:

| Task artifact | shapes_won | shapes_regressed | geomean | min_cons | worst_calc_diff |
|---------------|------------|------------------|---------|----------|-----------------|
| `moe_decode_official_r10a` | 2 | 0 | 1.0567 | 1.0411 | 0.0 |
| `moe_decode_official_r10b` | 2 | 0 | 1.0551 | 1.0454 | 0.0 |
| `moe_prefill_official_r10a` | 3 | 0 | 1.0539 | 1.0058 | 0.0 |
| `moe_prefill_official_r10b` | 3 | 0 | 1.0459 | 1.0038 | 0.0 |
| `dsa_prefill_attn_official_r10` | 3 | 0 | 2.1213 | 2.0691 | 2.8842527531880435e-06 |
| `index_score_prefill_official_r10` | 3 | 0 | 2.8416 | 1.5321 | 0.0 |

## Part 4: Goal Tracker Update

I did not edit `goal-tracker.md`. The mutable section already reflects Round 4:
Plan Version 6, task10 and task16 completed, generated-KB blocker resolved,
no active blocking side issues, no explicit deferrals, and the two remaining
infra findings queued.

## Part 5: Progress Stagnation Check

No stagnation trigger. Although the loop required multiple review rounds, the
issues were not repeated unresolved mistakes: each round closed the prior round's
specific blocker and exposed a narrower finalization requirement. The final
Round-4 state has no blocking side issues and no deferred ACs.

## Action Items

Mainline Gaps: None.

Blocking Side Issues: None.

Queued Side Issues:

- Keep documenting/exporting `AITER_TRITON_ONLY=0` for future MoE gates until the
  result schema or default env records it.
- Fix or regenerate non-MoE `run.sh` Python selection in a separate owner-approved
  infrastructure pass.

COMPLETE
