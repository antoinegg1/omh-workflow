**Decision: green-light KEEP.**

1. **Hard constraints:** Yes. The supplied authoritative full-sweep data for sha `7698920e` passes correctness and no-regression: worst `calc_diff=2.884e-6 < 5e-6`, `post_timing_correct=True`, `complete_sweep=True`, `shapes_won=3`, `shapes_regressed=0`, and every conservative ratio is ~`2.10x+`. It strictly improves the prior accepted DSA win from ~`1.29x/1.30x` to ~`2.115x/2.125x`.

2. **Reward/timing validity:** I see no reward-hacking red flag. The fp32 `YQ` workaround is acceptable because it is candidate-local, import-time probed, writes true fp32, does not mutate env in `run()`, does not change inputs/reference/tolerances, and falls back to fp32 einsum on failure. Conservative margin is interpreted correctly: candidate p90 versus reference p10. Cold-L2 timing, stable spreads, and poisoned-buffer post-timing correctness are exactly the right evidence.

3. **Finalize:** Yes, advance with this as the round win. Treat `index_score` as NO-GO at its launch-config optimum and the MoE tasks as environment-blocked, assuming they remain unchanged.

One process note: in this checkout I verified the candidate hash is `7698920e...`, but I do **not** see the new 3-shape `2.11x` `result.json` under `runs/glm52/dsa_prefill_attn/`; local saved runs only show the older ~`1.29x` artifacts. Make sure the final bundle/knowledge entry uses the actual authoritative full-sweep `result.json`, not `latest.json` from this workspace.
