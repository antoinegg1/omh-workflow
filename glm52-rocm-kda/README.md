# glm52-rocm-kda OMH Flow

This is the OMH workflow artifact for the campaign at:

```text
/home/lichangye/glm52-rocm-kda
```

It implements the initial 3 worker + 2 searcher topology:

- Worker A: `mla-prefill-attn`
- Worker B: `routed-expert-gate-up-down`
- Worker C: `dsa-index-score`
- Searcher A: external/source research into `wiki/**`
- Searcher B: campaign distillation into `wiki/**`

The flow intentionally removes separate plan and plan-review roles. The
implementer owns planning and implementation in one activation. Promotion then
passes through three read-only review layers plus script validation:

```text
implement -> implementReview -> rewardHackReview -> performanceReview -> validateAMD -> strictJudge
```

`implementReview` provides optimization guidance, `rewardHackReview` checks
integrity and benchmark shortcuts, `performanceReview` checks formal speedup
evidence, and `validateAMD` probes ROCm/GPU plus formal smoke before strict
judge.

Start from the campaign root:

```bash
source /home/lichangye/rocm_env.sh
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
cd /home/lichangye/glm52-rocm-kda
export GLM52_KDA_CAMPAIGN_ROOT=/home/lichangye/glm52-rocm-kda
export OMH_WORKFLOW_AGENT_BACKEND=auto
omh workflow start /home/lichangye/omh-workflow/glm52-rocm-kda/glm52-rocm-kda.omhflow --run-id glm52-kda-1 --max-node-activations 10 --agent-retry-max-attempts 6 --background
```

This workflow expects the local OMH runtime branch with coding CLI backends:

```bash
cd /home/lichangye/oh-my-humanize
git switch codex-rebase-humanfia-20260708
export PATH="$HOME/.bun/bin:$PATH"
omh workflow --help
```

Backend routing is model-family based:

- `infini/gpt-5.5:xhigh` routes through `codex exec`.
- `infini/claude-opus-4-8:xhigh` routes through `claude --print`.
- `OMH_WORKFLOW_AGENT_BACKEND=omh|codex|claude` can force a backend for diagnosis.

## Local OMH Smoke Provider

The production workflow keeps its remote model roles. On this machine, OMH has
no configured remote LLM credentials yet, so use the local smoke workflow to
test workflow scheduling, task spawning, review gates, and script nodes:

```bash
cd /home/lichangye/glm52-rocm-kda
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
export PI_CODING_AGENT_DIR=/home/lichangye/glm52-rocm-kda/.omp/agent
python3 tools/omh_mock_openai_server.py --host 127.0.0.1 --port 8000
omh workflow start /home/lichangye/omh-workflow/glm52-rocm-kda/glm52-rocm-kda-local.omhflow --cwd /home/lichangye/glm52-rocm-kda --max-activations 1 --json
```

The local flow shares resources through the `glm52-rocm-kda-local ->
glm52-rocm-kda` symlink. The mock server path is legacy. With the coding CLI
backend branch, normal local smoke should use Codex/Claude Code auth and
`OMH_WORKFLOW_AGENT_BACKEND=auto`.

The Day-1 acceptance command outside OMH is:

```bash
cd /home/lichangye/glm52-rocm-kda
$ROCM_TORCH_VENV/bin/python tools/validate_campaign.py --smoke-run
```

Concrete optimization task packages are not stored in the workflow artifact.
They live at:

```text
/home/lichangye/glm52-rocm-kda-tasks
```
