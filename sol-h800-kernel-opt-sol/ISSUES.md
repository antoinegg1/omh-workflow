# sol-h800-kernel-opt-sol — Known Issues & Diagnosis

_Last updated: 2026-07-07. Author: campaign debugging session._

This document records the problems the `sol-h800-kernel-opt-sol` workflow currently faces
when run as a long, multi-lane optimization campaign, the root causes found so far, what has
been tried, and the open decisions. It is meant to save the next person from re-deriving all
of this.

---

## TL;DR

The flow itself is **correct and validated** (freezes clean at 118 nodes / 164 edges; all
config knobs work; wiki lane + meeting sub-flow work end-to-end in smoke tests). The blocker
is **operational, not structural**: the InfiniAI model gateway is intermittently unstable, and
the omh engine is **fail-fast with no per-node fault tolerance**, so a single stalled model call
kills the entire campaign. Every long run so far has died this way.

---

## Problem 1 — InfiniAI gateway drops / hangs large requests

**Symptom.** Agent nodes that issue large LLM requests (`implementCandidate`, `draftPlan`,
`revisePlan`, `wikiSearch*`) periodically produce **zero stream activity** — the request is
dispatched but no token (not even reasoning) comes back. The stall watchdog reports:

```
workflow task progress stalled for node "<node>" after <N>ms without new activity;
last activity: task started
```

`last activity: task started` = the call never streamed anything from the very beginning.

**What was ruled out.**
- Not a workflow bug: single, isolated API probes to the gateway often succeed.
- Not one model: first observed on `glm-5.2` / `deepseek-v4-pro` (returned HTTP 200 with
  **empty content** — 0/4 non-empty in a probe), then reproduced on `gpt-5.5` (a large CUDA
  prompt via the responses API **hung >150s and never returned**).
- Not the stall timeout being too aggressive: reasoning/thinking deltas DO reset the watchdog
  (verified in `session-runtime.ts` — every `message_update` stream event calls
  `scheduleProgress`), so a genuinely-thinking call is never killed. Only true zero-stream
  hangs trip it.

**Conclusion.** This is **InfiniAI-side gateway degradation on large/streaming requests**,
time-varying. Switching the model does not help when the whole gateway is struggling.

---

## Problem 2 — Fail-fast engine has no per-node fault tolerance (the real blocker)

**Root cause of every campaign death.** The omh scheduler is hard fail-fast. In
`oh-my-humanize/packages/coding-agent/src/workflow/scheduler.ts` (~L161-168):

```ts
if (result.error !== undefined) {
    result.activation.status = "failed";
    stopScheduling = true;                    // <-- stops the WHOLE run
    failureController.abort(`workflow activation ${nodeId} failed: ${error}`);
}
```

So when any one node **exhausts its retries and hard-fails**, `stopScheduling` is set and the
engine aborts the entire run — SIGTERM-ing every sibling node still in flight (they show up as
`exit code 143`). A typical death looks like this (all same timestamp = one cascade):

```
draftPlanA    :: ... progress stalled ...      <- the real failure (retries exhausted)
wikiSearchAW  :: ... draftPlanA failed ...      <- aborted (cascade)
wikiSearchBW  :: ... draftPlanA failed ...      <- aborted (cascade)
revisePlanB   :: exit code 143                  <- SIGTERM (cascade)
revisePlanC   :: exit code 143                  <- SIGTERM (cascade)
```

**Why this is fatal in combination with Problem 1.** Each agent node retries a transient/stall
failure up to **6 times** with exponential backoff (`baseDelayMs 30s × 2^(attempt-1)`, cap
300s, 0.25 jitter — already built into `session-runtime.ts`). But when the gateway is broadly
hanging, even 6 retries of a node can all stall, so the node hard-fails → fail-fast → whole
campaign dies. A **non-critical** node (e.g. a `wikiSearch*` searcher, which only gathers
knowledge) can therefore kill the **core optimization** lanes.

---

## What has been tried (and why it wasn't enough)

| Attempt | Change | Result |
|---|---|---|
| Shorten stall watchdog | `OMP_WORKFLOW_PROGRESS/RETRY_STALL_TIMEOUT_MS=150000` (600s→150s) in launch env | Detects hangs ~4× faster, but doesn't stop the eventual hard-fail when the gateway stays down. |
| Switch searchers off glm/deepseek | Remapped `searchA`/`searchB` roles → `gpt-5.5:xhigh` | Helped when only glm/deepseek were empty; useless once gpt-5.5 also started hanging. |
| Concurrency-aware read-only guard | `runner.ts` fix (only assert workspace-unchanged when a read-only node ran in isolation) | Fixed a *different* real bug (parallel wiki writes tripping worker read-only guards); orthogonal to Problems 1–2. Pushed to `antoinegg1/oh-my-humanize` branch `feat/workflow-readonly-guard-concurrency`. |
| Exponential backoff | Already present in the engine | Correct, but 6 attempts isn't enough during a sustained gateway outage. |

None of these address the core combination: **flaky provider + fail-fast engine**.

---

## Open decisions (root-cause fixes, not yet applied)

1. **Wait out the gateway.** Simplest. Probe InfiniAI periodically; only run campaigns when
   large streaming requests are reliably succeeding. Zero code change. Downside: unattended
   throughput depends entirely on provider health.

2. **Supervisor auto-restart.** Wrap the campaign in an outer loop that relaunches when the run
   dies from a provider failure (disk progress is preserved; the ordered selector resumes at
   the first not-done task). NOTE: earlier in this project the user explicitly rejected *blind*
   auto-restart for **flow bugs** (the rule: diagnose + fix each failure). A provider-outage
   restart is arguably different in kind (external cause, nothing to fix in the flow), but this
   should be an explicit, deliberate choice, and it should still surface/log the real failing
   node each time rather than mask it.

3. **Per-node fault tolerance in the engine (true root fix).** Make selected nodes
   **non-fatal**: a failure in a non-critical node (the wiki lane `wikiSearch*` / `wikiReview` /
   `wikiWrite`, and arguably the meeting sub-flow) should NOT set `stopScheduling`. Only
   worker-lane failures (`implement`/`validate`/`promote`) should be able to stop a lane — and
   ideally even a worker-lane failure should only fail *that lane*, not the whole campaign.
   This requires a scheduler change (e.g. a per-node `optional: true` / `continueOnError` flag,
   or lane-scoped failure domains) in `scheduler.ts` + `definition.ts`. Largest change, needs
   tests, but it's the only option that makes long unattended runs robust to a flaky provider.

**Recommendation:** short term, (1) wait for the gateway; medium term, (3) add per-node
fault tolerance so a non-critical searcher can never again kill the optimization. (2) is a
stopgap if unattended throughput is needed before (3) lands.

---

## Reference: how to diagnose a death quickly

- The run's `--json` summary only writes the final `run.status` + `frontier` (the *unfinished*
  nodes, NOT the failing one). To find the real cause, read
  `workflow-output/omh-runtime/observability.json` and look for the **first** `status: failed`
  entry whose summary is NOT `exit code 143` (143 = SIGTERM cascade victim, not the cause).
- All cascade victims share the failing node's timestamp.
- `progress.md` in the same dir is the human-readable live view (Completed/Failed/Running).
- The flow, prompts, and scripts here are byte-identical to the live copy under
  `/mnt/public/lichangye/kernel-opt-test/workflows/sol-h800-kernel-opt-sol/`.
