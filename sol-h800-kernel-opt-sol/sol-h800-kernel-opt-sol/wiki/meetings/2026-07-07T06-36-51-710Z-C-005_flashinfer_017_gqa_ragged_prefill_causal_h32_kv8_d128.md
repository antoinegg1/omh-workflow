# Meeting — 005_flashinfer_017_gqa_ragged_prefill_causal_h32_kv8_d128 (lane C)

- When: 2026-07-07T06:36:51.710Z
- Task: tasks/005_flashinfer_017_gqa_ragged_prefill_causal_h32_kv8_d128
- Trigger: 2 consecutive rounds without improvement
- Decision: **revise_candidate**

## Rationale

All five speakers converge that workflow_20260707062445 is correctness-clean but not promotable: it loses P50 and also regresses mean/p90/max versus the reward-passed pair2_init_guard. Coordinator, planner, reviewer, GLM, and DeepSeek all prefer restoring pair2_init_guard as the lane control and sweeping the init-guard dispatch threshold before profiling or rewriting kernels. The real dissent is against treating the +0.000336 ms P50 gap as noise, against promoting the current candidate, and against jumping to fused/persistent or Blackwell-oriented ideas without H800 evidence. Profiling is deferred unless matched retests or threshold sweeps produce unexplained row 5/6/20 behavior.

## Next candidate direction

Create the next candidate from the exact reward-passed pair2_init_guard code path, not from workflow_20260707062445. Preserve SOL correctness and legal dispatch semantics, then sweep one init-guard/small-vs-long runtime threshold at a time using only tensor/indptr/shape metadata. Gate each variant on 21/21 correctness, H800 P50 versus pair2_init_guard, and per-row latency for rows 5, 6, and 20, with rows 5/6 treated as the primary tail suspects and row20 as a monitored secondary check.

## Must do next

- Restore pair2_init_guard as the control and run matched back-to-back H800 retests against workflow_20260707062445; require 21/21 correctness and record aggregate plus per-row deltas.
- From restored pair2_init_guard, sweep only one legal init-guard dispatch threshold at a time around the existing guard, including the tq 35/71/92 neighborhood if those are the active shape breakpoints.
- Promote a sweep result only if it beats pair2_init_guard on local H800 P50 without worsening rows 5/6/20 tail behavior or mean/p90/max beyond retest variance.
- If restored pair2_init_guard fails to reproduce or a threshold causes unexplained row 5/6 tail loss, then profile only those regressing long-row workloads with NCU before considering fused/persistent work.

## Full decision

```json
{
  "decision": "revise_candidate",
  "rationale": "All five speakers converge that workflow_20260707062445 is correctness-clean but not promotable: it loses P50 and also regresses mean/p90/max versus the reward-passed pair2_init_guard. Coordinator, planner, reviewer, GLM, and DeepSeek all prefer restoring pair2_init_guard as the lane control and sweeping the init-guard dispatch threshold before profiling or rewriting kernels. The real dissent is against treating the +0.000336 ms P50 gap as noise, against promoting the current candidate, and against jumping to fused/persistent or Blackwell-oriented ideas without H800 evidence. Profiling is deferred unless matched retests or threshold sweeps produce unexplained row 5/6/20 behavior.",
  "next_candidate_direction": "Create the next candidate from the exact reward-passed pair2_init_guard code path, not from workflow_20260707062445. Preserve SOL correctness and legal dispatch semantics, then sweep one init-guard/small-vs-long runtime threshold at a time using only tensor/indptr/shape metadata. Gate each variant on 21/21 correctness, H800 P50 versus pair2_init_guard, and per-row latency for rows 5, 6, and 20, with rows 5/6 treated as the primary tail suspects and row20 as a monitored secondary check.",
  "must_do_next": [
    "Restore pair2_init_guard as the control and run matched back-to-back H800 retests against workflow_20260707062445; require 21/21 correctness and record aggregate plus per-row deltas.",
    "From restored pair2_init_guard, sweep only one legal init-guard dispatch threshold at a time around the existing guard, including the tq 35/71/92 neighborhood if those are the active shape breakpoints.",
    "Promote a sweep result only if it beats pair2_init_guard on local H800 P50 without worsening rows 5/6/20 tail behavior or mean/p90/max beyond retest variance.",
    "If restored pair2_init_guard fails to reproduce or a threshold causes unexplained row 5/6 tail loss, then profile only those regressing long-row workloads with NCU before considering fused/persistent work."
  ],
  "risks_to_watch": [
    "Mistaking the small P50 regression for noise while repeated row 5/6 tail losses persist.",
    "Reward-hack thresholds keyed to row id, workload order, trace path, safetensor path, pointer identity, or other non-shape artifacts.",
    "Breaking causal/KV initialization semantics; needs_init must remain true for legal unwritten zero/-inf cases such as q_len > 0 && kv_len < q_len.",
    "Recovering P50 by shifting dispatch while silently damaging rows 5/6/20, mean, p90, or max.",
    "Spending revision rounds on fused/persistent or Blackwell-only ideas before the H800 pair2_init_guard threshold headroom is exhausted."
  ],
  "consensus": [
    {
      "point": "Do not promote workflow_20260707062445.",
      "support": "All speakers cite 21/21 correctness but worse P50, mean, p90, and max than pair2_init_guard.",
      "dissent": "None."
    },
    {
      "point": "Primary next action is rollback-plus-threshold sweep, not a new kernel.",
      "support": "Coordinator, planner, reviewer, GLM, and DeepSeek all recommend restoring pair2_init_guard and sweeping init-guard dispatch first.",
      "dissent": "No speaker argues for immediate fused/persistent work; several explicitly dissent from it."
    },
    {
      "point": "The regression should not be dismissed as pure timing noise yet.",
      "support": "All speakers note the P50 gap is small but paired with row 5/6 and tail regressions, making a matched stability retest mandatory.",
      "dissent": "Only uncertainty is variance magnitude; GLM and DeepSeek ask for repeated per-row runs before final attribution."
    },
    {
      "point": "Profiling is conditional, not first.",
      "support": "Planner, reviewer, and DeepSeek recommend NCU only if restored baseline fails to reproduce or threshold changes create unexplained tail loss.",
      "dissent": "None supporting profile-first."
    },
    {
      "point": "Dispatch changes must use legal shape metadata only.",
      "support": "Coordinator, planner, reviewer, GLM, and DeepSeek all flag row-id/path/pointer keyed thresholds as reward-hack risk.",
      "dissent": "None."
    }
  ],
  "confidence": "high"
}
```
