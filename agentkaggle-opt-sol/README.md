# agentkaggle-opt-sol

Generic multi-task Kaggle optimization workflow. It runs one global coordinator, four asynchronous worker lanes (A-D), and one asynchronous GPT-5.5 Searcher.

The preserved 3-worker / 2-searcher topology is a separate static workflow at
`../agentkaggle-opt-sol-3x2/`. Use this directory for the current 4/1 topology;
the lane counts are not switched dynamically inside one artifact.

```text
Global Coordinator
  |-- Worker A: select -> PlanImplement <-> functional review -> validate/repair
  |              -> reward review -> direct calibration or performance review
  |              -> restore best -> outer-round gate
  |-- Worker B: same
  |-- Worker C: same
  |-- Worker D: same
  `-- Searcher: one assignment -> research/maintain/distill -> wiki -> repeat
```

The coordinator owns task selection and campaign direction globally. It is not one of the parallel worker lanes. Worker lanes return asynchronously and may spend very different amounts of time on their current tasks.

## Campaign root

Start the workflow with the campaign directory as cwd. The root contract is:

- `task.md`: campaign goal and selection policy.
- `tasks.json`: task facts, metrics, targets, submission limits, and evaluation commands.
- `leaderboard.json` / `leaderboard.csv`: remote-primary best results.
- `runs/<task>/`: candidate ledger, score history, submission ledger, docs, meetings, and full candidate solution snapshots.
- `wiki/`: shared task and pattern knowledge written by the Searcher.
- `workflow-output/`: runtime state, lane outputs, locks, checkpoint metadata, and campaign status.
- `$AGK_INSTANCE_ROOT/agk-<runTag>-<task>/`: writable task instance. Agents may edit only `solution/**` inside it.

Refresh percentile thresholds only while the workflow is paused:

```sh
bun /root/omh-workflow/agentkaggle-opt-sol/agentkaggle-opt-sol/scripts/refresh-progressive-targets.js \
  --root /root/agnetkaggle_13
```

The command downloads all enabled public leaderboards, replaces the latest raw snapshot only after every leaderboard parses successfully, reclassifies existing best scores, and synchronizes the managed current-goal block in each task `TASK.md`.

## Worker lifecycle

One task acquisition is a stint:

- Optimization budget: 16 hours shared across the entire stint.
- Finalization grace: 2 hours after optimization expires. The workflow restores the stint best before final validation/review; it will not start finalization after the grace expires.
- Outer rounds: at most 5 validation-passed rounds per stint.
- Each outer round starts a PlanImplement episode and functional review cycle. The implementer reads the task contract, wiki, and coordinator selection reason, then chooses its own technical direction and experiment depth.
- Initial PlanImplement activation has a 16-hour node ceiling but must obey the absolute stint deadline.
- Each functional review has a 1-hour ceiling. Each requested rework activation has a 4-hour ceiling. Review/rework count is not capped; the stint deadline is the cap.
- The reviewer checks functionality and may request a concrete material improvement without prescribing a fixed domain-specific exploration process.
- Validation failures enter the existing bounded correctness-repair loop.
- After reward review, the workflow records a complete solution snapshot plus solution and actual upload-payload SHA-256 hashes.

At round or stint close, candidate restoration is remote-primary: among Kaggle-scored candidates, direction-aware Kaggle score wins; when no candidate is remotely scored, lowest direction-normalized local cost wins.

## Submission policy

Agents never call Kaggle directly. `promote-and-update-leaderboard.js` is the only uploader and retains the daily cap ledger, transport fallbacks, score polling, provenance, and leaderboard reconciliation.

There are two routes:

- Direct calibration: when `remaining_today > 5`, a validated, reward-passed candidate with new solution and upload-payload hashes is eligible automatically unless PlanImplement explicitly skips it. Local or remote monotonic improvement is not required. At most one submission may be pending.
- Low-quota flow: when `remaining_today <= 5`, direct looping is disabled. A complete outer round may upload at most once through performance review. Spending the final daily submission requires an explicit PlanImplement decision.

Remote route calibrations may score below the historical best. They remain in the route history while `leaderboard.json` and `best_manifest.json` preserve the direction-best Kaggle public score.

Remote Kaggle score is the only final score. Local score is an iteration signal normalized as `cost = higher_is_better ? -score : score`, so lower cost always wins locally.

## GPU pool

The workflow has a capacity-2 GPU semaphore at `workflow-output/locks/gpu-pool/slot-{0,1}`. Harness validation, profiling, and full-fit operations use it automatically. Agent-run GPU commands must use:

```sh
bun "$OMP_WORKFLOW_RESOURCE_DIR/scripts/run-with-gpu-pool.js" \
  --root /path/to/campaign --lane A --task xNN-task \
  --gpus 1 --timeout-seconds 3600 -- command args...
```

`--gpus` accepts `1` or `2`. A two-GPU request waits until both slots are available and receives both through `CUDA_VISIBLE_DEVICES`.

## Coordination and search

The global coordinator writes only `runs/_campaign/**`:

- `direction.md`: campaign-wide direction and budget posture.
- `lane-A.md` through `lane-D.md`: current and next worker assignments.
- `searcher.md`: the single Searcher's standing queue.

The Searcher receives one assignment at a time and decides its own research cadence. It may research public sources, maintain the wiki, or distill this campaign's own candidate artifacts. It writes only `wiki/**` and reports through `wiki/.reports/searcher.json`.

Distillation prioritizes implementation trajectories that produced significant full-local/remote gains or reusable machinery. A distilled trajectory records the bottleneck, hypothesis sequence, decisive tests, failed branches, reusable operators, and likely next applications; ordinary small improvements do not automatically become standing wiki guidance.

After 5 consecutive validation-passed rounds without a lower cost, the coordinator sees the task as stalled but retains full dispatch authority. It may switch tasks, change route, target the Searcher, or assign a normal lane round to build a solution-local evaluator.

## Meeting

Meeting is a legacy optional A-C stall-consult path and is disabled by default. Lane D does not contain a meeting branch. Enable it only for compatibility or targeted experiments with `SOL_H800_ENABLE_MEETING=1`; normal operation uses coordinator switching, functional review, and the Searcher instead.

The replaced draft -> plan review -> revise -> implement chain is archived under `legacy/plan-chain/` and is not part of the active workflow.

## Write scopes

Hardcoded guards in `scripts/lane-utils.js` enforce:

| Role | Writable paths |
|---|---|
| global coordinator | `runs/_campaign/**` |
| PlanImplement / correctness repair | instance `solution/**`, `runs/<task>/docs/**` |
| next-step coordinator | `runs/<task>/docs/**` |
| Searcher | `wiki/**` |
| reviewers and meeting speakers | none |

## Environment

| Variable | Default | Effect |
|---|---:|---|
| `SOL_H800_WORKER_LANES` | `4` | Enable 1-4 worker lanes. |
| `SOL_H800_SEARCH_AGENTS` | `1` | `0` disables Searcher, `1` enables it. |
| `SOL_H800_ENABLE_MEETING` | `0` | Enable legacy A-C meeting branches. |
| `SOL_H800_USE_COORDINATOR` | `1` | `0` uses scripted task selection. |
| `SOL_H800_TASK_BATCH` | unset | Forced per-lane task list. |
| `SOL_H800_TASK_DIR` / `SOL_H800_FORCE_TASK` | unset | Force one task. |
| `SOL_H800_TASK_RANGE` / `SOL_H800_TASK_SKIP` | unset | Filter task orders. |
| `SOL_H800_TASK_LOCAL_MAX_ROUNDS` | `5` | Validation-passed outer rounds per stint. |
| `SOL_H800_MAX_NO_IMPROVE_ROUNDS` | `5` | Window stall threshold. |
| `SOL_H800_STINT_BUDGET_SECONDS` | `57600` | Shared optimization time. |
| `SOL_H800_STINT_FINALIZATION_GRACE_SECONDS` | `7200` | Post-deadline finalization grace. |
| `SOL_H800_TASK_LOCK_STALE_H` | `24` | Reap an apparently abandoned task lock; must exceed stint plus grace. |
| `SOL_H800_DIRECT_SUBMISSION_THRESHOLD` | `5` | Direct route requires more than five remaining submissions; five or fewer use the full round flow. |
| `SOL_H800_VALIDATION_MAX_FAILURES` | `3` | Correctness-repair budget. |
| `SOL_H800_VALIDATION_TIMEOUT_S` | `3000` | Harness local-evaluation timeout. |
| `SOL_H800_PAUSE_AFTER` / `SOL_H800_PAUSE_AT` | unset | Graceful timed pause. |
| `AGK_INSTANCE_ROOT` | `/root/autokaggle/omh_runs` | Writable instance root. |
| `AGK_FRESH_INSTANCES` | unset | `1` creates a fresh run tag. |
| `AGK_RUN_DIAG` | unset | `1` forces diagnostics. |
| `AGK_KAGGLE_PYTHON` | `python3` | Python used by Kaggle transport helpers. |

## Start and resume

### Cross-machine runtime setup

This workflow keeps orchestration in OMH but delegates headless model work to
the local coding CLIs:

- GPT/OpenAI/Rustcat model patterns run through `codex exec`.
- Claude/Anthropic/Infini model patterns run through `claude --print`.
- Unknown model patterns retain the legacy OMH child-agent backend.

Use the matching runtime branch when installing OMH on another machine:

```sh
git clone https://github.com/antoinegg1/oh-my-humanize.git
cd oh-my-humanize
git switch --track origin/workflow/coding-cli-backends-20260721
bun install
sh scripts/link-omp.sh
```

Install Codex and Claude Code separately and verify that `codex --version` and
`claude --version` work in the supervisor environment. Keep provider routes and
credentials machine-local:

- Codex reads `~/.codex/config.toml` and its normal auth store.
- Claude Code reads `~/.claude/settings.json` and its normal auth store.

The workflow does not require official provider authentication when those CLI
profiles already route to a compatible local provider. Do not copy either
machine's credentials into this repository.

`OMH_WORKFLOW_AGENT_BACKEND=auto` is the default. Set it to `omh`, `codex`, or
`claude` to force one backend for diagnosis. The `omh` value is the emergency
rollback path and does not change workflow/checkpoint data.

Codex returns raw JSON because some OpenAI-compatible Responses routes reject
native JSON-schema requests; OMH validates the activation envelope and retries
one malformed result. Claude Code uses its structured-output schema directly.
Both backends stream JSONL transcripts into the normal workflow agent artifact
directory, so the existing liveness watchdog and observability files continue
to work.

```sh
export PATH="$HOME/.bun/bin:$PATH"
cd /root/agnetkaggle_13
omh workflow start /root/omh-workflow/agentkaggle-opt-sol/agentkaggle-opt-sol.omhflow \
  --run-id agk-1 --background
```

Monitor `workflow-output/omh-runtime/progress.md`, `observability.json`, and `workflow-output/omh-supervisor-status.json` when the external supervisor is used.

The supervisor is not a workflow role. It is an out-of-process launcher and recovery monitor in `supervise-campaign.ts`. Durable campaign state lives in `leaderboard.json`, `runs/`, `wiki/`, `workflow-output/run-tag.txt`, and task instances. The supervisor can resume a failed OMH process from its checkpoint bundle, then fall back to a fresh process using the same durable campaign state if checkpoint recovery is exhausted.

Example supervised run:

```sh
cd /root/agnetkaggle_13
bun /root/omh-workflow/agentkaggle-opt-sol/supervise-campaign.ts \
  --cwd /root/agnetkaggle_13 \
  --flow /root/omh-workflow/agentkaggle-opt-sol/agentkaggle-opt-sol.omhflow \
  --duration-seconds 28800 \
  --min-free-gb 40
```

`--min-free-gb` defaults to 40 and stops an attempt before transient training or artifact generation can exhaust the campaign filesystem.

No workflow start or supervisor run is performed by tests in this repository.
