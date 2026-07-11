# agentkaggle-opt-sol

Generic Kaggle-campaign optimization workflow, forked from `sol-h800-kernel-opt-sol`.
Runs a multi-task campaign: 3 worker lanes (A/B/C) iterate on tasks
(select → plan ⟳ review → implement → validate ⟳ repair → reward-hack review →
performance review → promote+submit → loop), one always-on search lane
(coordinator-directed research/maintain over a shared wiki), and a per-lane
stall-recovery meeting sub-flow.

## Campaign root contract (cwd when starting the flow)

- `task.md` — the campaign's own contract (selection policy etc.; agents read and judge it themselves)
- `tasks.json` — task manifest: `{order, group, sol_id, task_dir, comp_slug, metric, higher_is_better, target_top1, target_top5, daily_cap, benchmark_ready, local_signal, edit_file, submission_file, eval_fast_args, full_fit_args, python_bin}` (facts only, no policy)
- `leaderboard.json` / `leaderboard.csv` — remote-primary leaderboard (kaggle_public is the value; local cost auxiliary)
- `runs/<task-dir>/` — per-task campaign artifacts: candidates.jsonl, scoreboard.jsonl, submission_log.jsonl, best_manifest.json, docs/, meetings/, candidates/<candidate>/ snapshots
- `wiki/` — shared knowledge base (search lane writes; everyone else reads): tasks/, meetings/, patterns/, index.md, sources.jsonl
- Writable run instances (materialized by the selection guard): `$AGK_INSTANCE_ROOT` (default `/root/autokaggle/omh_runs`)/`agk-<runTag>-<task-dir>/` — only `solution/` inside an instance is agent-editable

## Conventions

- **cost = higher_is_better ? -score : score** — every comparator sorts ascending cost.
- **Remote-primary**: the Kaggle score from `submit.py --score-only` is the only final score; local evaluation is an iteration signal. Daily submission caps are hard, ledger-enforced (`runs/<task>/submission_log.jsonl`).
- **GPU pool**: all harness evaluations run inside a capacity-2 semaphore (`workflow-output/locks/gpu-pool/slot-{0,1}` → `CUDA_VISIBLE_DEVICES`); a third request queues.
- **Write-permission matrix** (hardcoded in `scripts/lane-utils.js` `WRITE_MATRIX`, enforced by guard scripts; prompts only inform):
  | agent | may write |
  |---|---|
  | campaign coordinator (selectTaskWorkload) | `runs/_campaign/**` only (its free-form direction docs; declared `files_changed` verified by the selection guard) |
  | planner (draftPlan/revisePlan) | `runs/<task>/docs/{draft,plan}.md` only |
  | implementer/repair | instance `solution/**` + `runs/<task>/docs/**` |
  | coordinator (reviseStrategy) | `runs/<task>/docs/**` |
  | searchers (wikiSearchA/B) | `wiki/**` only |
  | reviewers & meeting agents | nothing (statements go through state; archiver writes logs) |
- **Global coordination (ONE coordinator, two activation surfaces)**: the same campaign coordinator runs both the worker-lane selection nodes and the search-dispatch node. It owns `runs/_campaign/` (its only write scope, all free-form markdown, private to it): `direction.md` (global memory) plus five dispatch files of two kinds — `lane-A/B/C.md` (worker lanes) and `searcher-A/B.md` (searcher queues). The five lanes return asynchronously at different speeds; every coordinator activation re-reads the board fresh and dispatches for whoever is asking now. The two searchers are dispatched INDEPENDENTLY (`searchTopic.assignments.searchA/searchB` — same or different topics/kinds per round).
- **Meetings ↔ roles ↔ permissions linkage**: each of the five meeting speakers speaks AS its campaign role — a per-node `roleCharter` binding states the role's duties and write scope (verbatim from the matrix) and two role-specific observations are injected (planner→plan/implementationPlan, reviewer→validation/performanceReview, coordinator→leaderboard/progress, searchers→wiki/searchTopic). Speakers declare `commitments` executable within their own scope; the moderator dispatches `must_do_next` items with role prefixes (`planner: …`, `searchA: …`); the search coordinator reads meeting-guidance files for searcher-dispatched items. Full transcript (every speaker) → `runs/<task>/meetings/<ts>.md`; conclusions/consensus → `wiki/meetings/`.
- Filenames `validate-h800.js` / `optional-profile-h800.js` and the `SOL_H800_*` env prefix are kept from the fork parent so the graph and gate scripts stay untouched; their behavior is fully Kaggle-generic (local_eval validation / diagnostics rerun).

## Env knobs (all optional; defaults = full campaign)

| Var | Default | Effect |
|---|---|---|
| `SOL_H800_WORKER_LANES` | 3 | enable lanes A..(1-3) |
| `SOL_H800_SEARCH_AGENTS` | 2 | 0 disables the search lane |
| `SOL_H800_SIMPLIFY_PLAN` | off | off=plan⟳review, light=draft only, full=skip planning |
| `SOL_H800_USE_COORDINATOR` | 1 | 0 = scripted selector only |
| `SOL_H800_TASK_BATCH` | — | per-lane forced tasks `x13-...,x09-...,x11-...` |
| `SOL_H800_TASK_DIR` / `_FORCE_TASK` | — | single forced task |
| `SOL_H800_TASK_RANGE` / `_TASK_SKIP` / `_ORDERED_TASKS` | — | ordered/range selection by `order` |
| `SOL_H800_TASK_LOCAL_MAX_ROUNDS` | 3 | local optimization rounds per selection |
| `SOL_H800_PLAN_REVIEW_MAX_ROUNDS` | 2 | plan draft⟳review budget |
| `SOL_H800_VALIDATION_MAX_FAILURES` | 3 | repair loop budget |
| `SOL_H800_VALIDATION_TIMEOUT_S` | 5400 | local_eval hard timeout |
| `SOL_H800_PAUSE_AFTER` / `_AT` | — | timed graceful pause (e.g. `24h`) |
| `AGK_INSTANCE_ROOT` | /root/autokaggle/omh_runs | instance root |
| `AGK_FRESH_INSTANCES` | — | 1 = new runTag → fresh instances |
| `AGK_RUN_DIAG` | — | 1 = force a diagnostics run |

## Start

```sh
export PATH="$HOME/.bun/bin:$PATH"
cd /root/agnetkaggle_13
omh workflow start /root/omh-workflow/agentkaggle-opt-sol/agentkaggle-opt-sol.omhflow \
  --run-id agk-1 --background
# monitor: workflow-output/omh-runtime/progress.md, observability.json
```

Structural changes vs the fork parent: `wikiReviewW` (search reviewer) removed —
searchers write the wiki directly and `wikiWriteW` became a write-scope
guard + indexer joining both searchers via `waitFor`; searchers are
`workspaceAccess: write`, plan nodes explicitly `write`; `appendMeetingRecord*`
reads `meetingSpeakers` to archive full transcripts; validate/promote node
timeouts raised to 2h. Everything else in the 117-node graph is unchanged.
