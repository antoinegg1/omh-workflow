# Round 4 Summary

**Outcome: COMPLETE — the single Round-3-review blocker is resolved.** Codex's
Round-3 verdict was **ADVANCED**: the required append-only `testbench/knowledge`
entry (`glm52--moe_total_prefill--mi300x--20260723a`) was installed correctly and
`lint`/`query` passed, but clean closure was blocked by exactly one finding — the
Round-3 contract's own Definition of Done required `knowledge.py index --check` and
`distill --check` to be green, and Round 3 instead left them stale under an
"add-only" rationale. Those five outputs are git-tracked, so leaving them stale
was a real tree inconsistency and an unjustified deferral. **Round 4 regenerates
them.** No kernel code changed, no GPU gate was re-run, no frozen authority was
touched — this round refreshes generated files that are *derived from* the
already-committed entries.

---

## Work Completed — mainline objective (task10 + task16): RESOLVED

Regenerated the git-tracked generated knowledge-base bookkeeping so **all four**
`knowledge.py` validators pass:

```
python3 testbench/bin/knowledge.py index    → wrote queries/by-op.md, by-bottleneck.md, by-technique.md
python3 testbench/bin/knowledge.py distill   → wrote distilled.json + distilled.md (17 proven techniques)
```

### Why the diff is large but correct (fully entry-derived)

The generated files had last been built when the KB held only the **12** first-loop
B200 entries (`generated_from_entries: 12`). All **five** glm52 MI300X entries — the
four first-loop `20260722a` entries (`dsa_prefill_attn`, `index_score_prefill`,
`moe_total_decode`, `moe_total_prefill`) **plus** the Round-3 `20260723a` entry —
had never been folded into the query/distill views. Regeneration catches all five
up (`generated_from_entries: 12 → 17`). Every added line is derived from the
committed entries (technique names, `geo~1.0459`, bottleneck classes, etc.) — no
hand-editing, no new performance claim. The Round-3 `20260723a` entry now appears
**newest-first** under `moe_total` in `by-op.md`, and its three techniques
(`bit-exact-group-size-m-reshift`, `group-size-m-full-sweep-m4096`,
`decode-block-size-m-preservation-check`) appear in `by-technique.md`.

This is exactly the "pre-existing staleness" Round 3 flagged — but Codex correctly
ruled that regenerating (not deferring) is the required action: the files are
git-tracked, the round's own DoD required the checks green, and the diff is
**bounded to the generated files**, so nothing unrelated leaks.

## Files Changed (harness repo)

One commit, exactly the 5 generated files (`git status --porcelain` verified — no
`.humanize/`, no scratch, no more, no fewer):

- `7202073` — `knowledge: regenerate query/distill indexes to match committed
  entries`
  - `testbench/knowledge/queries/by-op.md` (+14)
  - `testbench/knowledge/queries/by-bottleneck.md` (+11)
  - `testbench/knowledge/queries/by-technique.md` (+52)
  - `testbench/knowledge/distilled.json` (+204/-2)
  - `testbench/knowledge/distilled.md` (+7/-2)
  - Total **5 files, +286/-2**. `knowledge:` scope; **no AI-authorship trailer**
    (verified); tree clean after commit.

No `candidate.py`, reference, taskset, `official_metrics`, correctness threshold,
cost model, device peak, timing, deployment metadata, task `run.sh`, or existing
`entries/*.json` change. The installed `20260723a` entry was left as-is.

## Validation

All four knowledge validators green at HEAD `7202073`:

```
knowledge.py lint                                              → 17 entries, 0 problems
knowledge.py query --task glm52/moe_total_prefill --gpu MI300X → glm52--moe_total_prefill--mi300x--20260723a [win geo=1.0459 minc=1.0038] (newest-first)
knowledge.py index --check                                     → 0 stale
knowledge.py distill --check                                   → up to date
```

AC-1 authority frozen (proof only generated KB docs changed):

```
python3 testbench/bin/selftest.py                              → 26 tasks, 0 problems
sync_glm52_tasks.py --check (env-unset)                        → 24 task dirs in sync  (benign "no CUDA" warning)
git status --porcelain                                         → clean
```

## Remaining Items

None blocking. Two infra follow-ups remain **queued** (owner/infra, out of scope
this round, non-blocking — no new GPU gate is run here):
- `AITER_TRITON_ONLY=0` remains manual provenance rather than result-schema state.
- Non-MoE task `run.sh` wrappers select the wrong Python when repo `.venv` is
  absent (frozen-authority generated wrappers).

## BitLesson Delta

- Action: update
- Lesson ID(s): BL-20260723-dual-knowledge-base-requirement
- Notes: Corrected the now-wrong `add-ONLY: do NOT regenerate queries/*.md or
  distilled.{json,md}` clause. Codex's Round-3 review ruled that leaving those
  git-tracked generated files stale was an unjustified deferral of a requirement I
  had written into my own Round-3 contract's definition-of-done (which required
  `index --check` and `distill --check` green). The updated lesson now instructs:
  after `knowledge.py add`, run `knowledge.py index` + `distill` and confirm ALL
  FOUR validators (`lint`, `query`, `index --check`, `distill --check`) green, then
  commit the regenerated `queries/*.md` + `distilled.{json,md}` alongside the entry;
  the regenerated diff is bounded to exactly the generated files and is fully
  entry-derived, so it does NOT violate AC-5 (verify with `git status --porcelain`
  before committing). Solution / Validation Evidence / Source Rounds fields were
  also extended with the Round-4 resolution. This is an in-place correction of an
  existing lesson (no new id) whose prior guidance would otherwise cause a repeat
  of the exact Round-3 mistake.
- Selector note: the `bitlesson-selector` subagent failed again this round (3rd
  time this session) with the same Bedrock `context_management: Extra inputs are
  not permitted` ValidationException — a confirmed environment/API outage in the
  subagent path, not a task issue. BitLesson selection was performed **inline**
  against `.humanize/bitlesson.md` (selected `BL-20260723-dual-knowledge-base-requirement`
  as the governing lesson; the three kernel/env lessons and two decode memories are
  N/A since no kernel/env/gate work occurred).

## Goal Tracker Update

- **task10 (Finalize report): needs revision → completed** — generated KB
  bookkeeping regenerated; all four validators green; committed `7202073`.
- **task16 (Install + refresh harness knowledge entry): needs revision →
  completed** — entry installed Round 3, generated indices refreshed Round 4.
- **Blocking Side Issue "Generated knowledge cross-reference/distill files are
  stale": RESOLVED** (Round 4, data-only).
- Plan Evolution Log: added Round-4 row; Plan Version → 6.
- Completed-and-Verified: added AC-5 Round-4 row (generated KB regenerated,
  verified Round 4).
- **AC-5: satisfied** (Round-3 DoD met; diff reviewable, bounded to 5 generated
  files, `.humanize/` excluded). **AC-1: held** (selftest 26/0, sync 24-in-sync;
  only generated KB docs changed). **AC-4: honored** (regenerated content is
  entry-derived, no new perf claim).

## Four-task state (unchanged this round)

No kernel change and no gate re-run, so all four official tasks remain at their
Round-2-verified state: decode 2/2, prefill 3/3, dsa 3/3, index_score 3/3;
`shapes_regressed == 0` on every official shape; calc_diff bit-exact/unchanged.
