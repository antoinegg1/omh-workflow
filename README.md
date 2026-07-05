# omh-workflow

OMH (`oh-my-humanize`) workflow definitions for GPU kernel optimization campaigns.

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

## Notes

- Model roles in the flow front-matter reference the `infini/` provider gateway;
  adjust `models.roles` to your own provider/model aliases before running.
- Absolute deployment paths have been parameterized via environment variables
  (`NCU_REPORT_HELPERS_DIR`, `H800_RUN_TASK_SCRIPT`) or made relative to the
  campaign root.
- `backups/` directories hold local candidate-solution snapshots and are
  git-ignored; they are not part of the flow definition.
