# omh-workflow

OMH (`oh-my-humanize`) workflow definitions for GPU kernel optimization and
Kaggle competition campaigns.

These are `.omhflow` artifacts intended to be run via `OMHFLOW_DIR` or installed
into an OMH workspace. Each flow ships its own `prompts/` and `scripts/`
resource directory.

## Flows

- **`sol-h800-kernel-opt/`** — a 5-worker parallel kernel-optimization campaign
  for SOL-ExecBench on H800. Each lane runs a
  select → plan(⟳review) → implement → validate(⟳repair) →
  reward-hack-review → performance-review → promote loop, with a per-task local
  optimization loop and a time-budget campaign outer loop. Cross-lane
  coordination is done through shared workflow state + a worker-pool slot guard.

- **`perf-takehome-kernel-opt-fast/`** — a lower-latency variant of the
  optimization loop for the VLIW cycle-simulator performance take-home.

- **`sol-h800-kernel-opt-sol/`** — a variant of `sol-h800-kernel-opt` with two
  extra features: (1) a dedicated **wiki-search lane** that runs in parallel with
  the worker lanes and continuously maintains a per-operator knowledge wiki from
  web-first search (two searchers — GLM 5.2 and DeepSeek V4 — reviewed/synthesized
  by GPT 5.5), looping until the coordinator ends the campaign; and (2) a
  **stall-recovery meeting** convened on any worker lane after two consecutive
  local rounds with no improvement, where five independent speakers
  (coordinator / planner / reviewer / GLM / DeepSeek) each advise from their own
  context and a GPT moderator synthesizes a binding decision that feeds the next
  revision round. Worker parallelism is 3 lanes (A/B/C); the local optimization
  loop defaults to 5 rounds.

  **Runtime configuration knobs** (env vars, read into `/config` state at startup;
  all default to the full-campaign behavior so an unset launch is unchanged):

  | Env var | Values | Effect |
  |---|---|---|
  | `SOL_H800_WORKER_LANES` | `1`–`3` (default `3`) | Enable only the first k worker lanes (A; A,B; A,B,C). |
  | `SOL_H800_SEARCH_AGENTS` | `0`–`2` (default `2`) | `0` disables the whole wiki-search lane; ≥1 runs it (both searchers). |
  | `SOL_H800_SIMPLIFY_PLAN` | `off`\|`light`\|`full` (default `off`) | `off` = full plan→review→revise; `light` = draft plan only (skip review/revise); `full` = no planning, go straight to finalize+implement. |
  | `SOL_H800_USE_COORDINATOR` | `0`\|`1` (default `1`) | `0` skips the LLM coordinator task-selection and always uses the script/forced selector (requires a task set via `SOL_H800_TASK_DIR`/`_BATCH`/ordered range). |

  Lanes are pre-built up to 3; going beyond 3 requires adding lane node-sets (the
  DAG is static — knobs gate pre-existing nodes, they do not synthesize new ones).

- **`agentkaggle-opt-sol/`** — a fork of `sol-h800-kernel-opt-sol` retargeted at
  **multi-task Kaggle campaigns** (developed on a 13-competition AgentKaggle
  benchmark; task facts live in the campaign root's `tasks.json` + `task.md`, so
  the flow itself is competition-agnostic). Same 3 worker lanes + 2-searcher wiki
  lane + stall-recovery meetings; the searcher-review node is removed (searchers
  edit the wiki directly under a write-scope guard with sidecar reports). Key
  adaptations:

  - **Remote-primary scoring**: the Kaggle leaderboard score is the only final
    score; local evaluation is a direction-normalized iteration signal
    (`cost` = lower-is-better). Daily submission caps are ledger-enforced; a
    task finalizes when its Kaggle-confirmed score reaches the top-1 target
    (early-exits the local loop, and the selection guard hard-rejects
    re-selection) or the reviewer declares the optimization limit.
  - **Submission transports**: `submit.py`/kaggle-CLI upload with one spaced
    retry and double-spend protection, a v1 REST fallback for competitions the
    v2 CLI 400-rejects, and a **kernel route** (push notebook → poll COMPLETE →
    verify output → submit kernel output) for notebook-only competitions;
    Kaggle-side `status=error` is surfaced as terminal `scoring_error`, and
    pending scores are backfilled by a throttled read-only sweep.
  - **Per-agent write-scope enforcement** hardcoded in guard scripts
    (`WRITE_MATRIX` in `lane-utils.js`): planners write only their plan docs,
    implementers only the instance `solution/` + task docs, searchers only
    `wiki/**`, the campaign coordinator only `runs/_campaign/**`; meetings are
    read-only and archived verbatim (full per-speaker transcripts under
    `runs/<task>/meetings/`, conclusions to `wiki/meetings/`).
  - **Progressive-disclosure wiki** (L0 index hooks → L1 `## TL;DR` → L2
    sections → L3 round details) with structure-aware excerpting, plus a
    standing search loop driven by the coordinator with three directives:
    `research` (external evidence), `maintain` (reorganize the wiki), and
    `distill` (mine the campaign's own solutions/sessions/meetings into
    reusable `wiki/patterns/` playbooks).
  - **Instance materialization**: each task gets a writable run instance
    (symlinked read-only data/evaluation + copied baseline `solution/`) under an
    external instance root; integrity is checked before/after every validation,
    and a GPU pool (capacity 2, file-lock semaphore) serializes eval jobs.
  - Same `SOL_H800_*` env knobs as the parent flow, plus 8-hour execution-node
    walls tuned for long training/eval turns.

## Notes

- Model roles and script evaluator calls use the local `rustcat/` and
  `anthropic/` provider aliases configured in this workspace.
- Absolute deployment paths have been parameterized via environment variables
  (`NCU_REPORT_HELPERS_DIR`, `H800_RUN_TASK_SCRIPT`) or made relative to the
  campaign root.
- `backups/` directories hold local candidate-solution snapshots and are
  git-ignored; they are not part of the flow definition.
