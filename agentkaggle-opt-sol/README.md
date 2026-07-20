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
- **Submission transport chain** (all inside `promote-and-update-leaderboard.js` — the ONLY node that submits; lanes never spend rounds on transport): each promotion tries, in order, until one lands:
  1. `python submit.py -m <msg>` (the package's own CLI/REST uploader);
  2. on failure: 45s wait → read-only census (`--score-only` message match) to guard against double-spend → one spaced retry;
  3. on v2-CLI `CreateSubmission … 400`: **legacy v1 REST** (allocate url → PUT bytes → create submission, Bearer auth), with a `submission.csv` rename retry if the API demands that filename;
  4. on `only accepts Submissions from Notebooks`: **kernel route** — `kaggle kernels push -p solution/` (needs lane-authored `solution/kernel-metadata.json` + `notebook_submission.ipynb` that re-runs the solver in-kernel, no static payload), poll to COMPLETE, verify the kernel produced `submission_file`, then `kaggle competitions submit -k <slug> -f <file> -v <version>`;
  5. any remaining failure: full stdout/stderr persisted to `runs/<task>/upload-failure-*.log`, status `upload_failed`, no cap spend.
  Kaggle-side `status=error` (evaluator rejected the file) is surfaced as terminal `scoring_error`; neither `upload_failed` nor `scoring_error` counts as round progress (the meeting streak accumulates). Slow scores are backfilled by a throttled read-only sweep, and `loadCampaignState` reconciles the leaderboard from each task's ledger (adopting the direction-best Kaggle-scored row and recomputing `reached_top1`) so a banked score can never stay invisible.
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
| `SOL_H800_PLAN_REVIEW_MAX_ROUNDS` | 2 | plan draft⟳review budget; rejected exhaustion releases the lane |
| `SOL_H800_VALIDATION_MAX_FAILURES` | 3 | repair loop budget |
| `SOL_H800_VALIDATION_TIMEOUT_S` | 3000 | local_eval hard timeout (kept below the 1h workflow node wall) |
| `SOL_H800_PAUSE_AFTER` / `_AT` | — | timed graceful pause (e.g. `24h`) |
| `AGK_INSTANCE_ROOT` | /root/autokaggle/omh_runs | instance root |
| `AGK_FRESH_INSTANCES` | — | 1 = new runTag → fresh instances |
| `AGK_RUN_DIAG` | — | 1 = force a diagnostics run |
| `AGK_KAGGLE_PYTHON` | `python3` | Python interpreter used only for Kaggle API dataset/kernel submission calls. |

## Window controls and supervised resume

Headless checkpoints are process-local, while this campaign deliberately keeps
its durable optimization state in `leaderboard.json`, `runs/`, `wiki/`,
`workflow-output/run-tag.txt`, and the writable instances. A new headless run
therefore resumes from disk state rather than attempting `/workflow restart`.

`workflow-output/campaign-controls.json` is an optional, expiring control file.
The loader exposes its priority list to the coordinator, the selection guard
rejects window-quarantined tasks, and the promotion node honors per-task
submission freezes. Controls become inactive at `expires_at`.

The repository supervisor runs a two-phase 8-hour window and archives every
attempt under `runs/_ops/omh-supervisor/<window-id>/`:

```sh
cd /root/agnetkaggle_13
tmux new-session -d -s omh-agk-8h \
  'bun /root/omh-workflow/agentkaggle-opt-sol/supervise-campaign.ts \
    --cwd /root/agnetkaggle_13 \
    --flow /root/omh-workflow/agentkaggle-opt-sol/agentkaggle-opt-sol.omhflow \
    --duration-seconds 28800'
```

The first phase assigns x02/x09/x11. It rolls to the full queue after all three
lanes release one stint or after two hours, whichever comes first. The second
phase prioritizes x06. The supervisor uses PID ancestry and runtime file
freshness instead of `pgrep -f`, avoiding command-line self-matches.

Current process and activation health is written atomically to
`workflow-output/omh-supervisor-status.json`; the live supervisor PID is in
`workflow-output/omh-supervisor.pid`. After repairing the supervisor or flow,
reuse the status file's `window_id` and `deadline_at` with `--window-id` and
`--deadline-at` so a restart keeps the original optimization window.

The approved `/root/agentkaggle-v2/runtime-venv` is executed read-only and is
never used as a task/solution source. Any new pip package writes are redirected
to this campaign's `workflow-output/python-packages` through `PIP_TARGET` and
`PYTHONPATH`.

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
