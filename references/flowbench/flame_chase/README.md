# Flame Chase FlowBench reference

This directory is a source snapshot of the FlowBench `flame_chase` family. It
was copied from:

- Repository: `/root/flowbench-internal`
- Source path: `src/flowbench/flows/flame_chase`
- Source commit: `bba6aaa740e24a2ecb6c63a72ba635fee54aa380`
- Last family changes: `0705e01` (rename to `flame_chase`) and `5657f46`
  (add Kimi K3 variants)
- License metadata: no `LICENSE`, `COPYING`, or `NOTICE` file was present in
  the source repository snapshot; confirm redistribution rights before making
  this reference public.

These files are reference material, not installable `.omhflow` artifacts. The
empty `flow.yaml` files are FlowBench family markers; `setup.py` depends on
`flowbench.workspace_utils` to stage the actual runner files into a benchmark
workspace.

## Variants

| Directory | Alternating agents |
|---|---|
| `fable5max_gpt56solmax` | Claude Fable 5 max and GPT-5.6 SOL max |
| `fable5max_k3max` | Claude Fable 5 max and Kimi K3 max |
| `fable5ultracode_gpt56solultra` | Claude Fable 5 ultracode and GPT-5.6 SOL ultra |
| `fable5ultracode_k3swarmmax` | Claude Fable 5 ultracode and Kimi K3 swarm max |
| `fable5xhigh_gpt56solxhigh` | Claude Fable 5 xhigh and GPT-5.6 SOL xhigh |
| `gpt56solmax_k3max` | GPT-5.6 SOL max and Kimi K3 max |
| `gpt56solultra_k3swarmmax` | GPT-5.6 SOL ultra and Kimi K3 swarm max |

Each `run.sh` loops indefinitely, reads `TASK.md`, and alternates fresh agent
turns with a five-second delay. The K3 swarm variants use `kimi_server.py` and
the local Kimi REST server instead of print mode.

## Safety

The runners deliberately use benchmark-grade unrestricted execution flags such
as `--dangerously-skip-permissions`,
`--dangerously-bypass-approvals-and-sandbox`, and
`--dangerous-bypass-auth`. Do not run them in an untrusted workspace or treat
them as the default execution policy for the OMH workflows in this repository.
