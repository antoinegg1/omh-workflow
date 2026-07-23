Q1: **Yes. Set `AITER_TRITON_ONLY=0` for valid `dsa_prefill_attn` gate runs.**

That is not authority tampering. The frozen reference is `glm52_ops.reference('dsa_attn', 'prefill', inputs)`, whose ROCm provider first attempts SGLang TileLang and only falls back to torch for debuggability when production modules are unavailable. If `AITER_TRITON_ONLY=1` prevents TileLang from importing, the gate is testing against the fallback oracle, not the intended ROCm/SGLang baseline. Do not set it inside the candidate or asymmetrically; set it for the whole run environment and record it.

Decision: **A. Pursue the Triton bf16-input/fp32-output QK kernel now.**

Reason: this is the only path in the briefing that is both plausibly fast and plausibly correct. The current bottleneck is QK. Torch exposes either fast bf16 with bf16-rounded output, which fails `calc_diff`, or correct fp32/slow fp16 paths that do not produce a real win. A Triton `tl.dot` path with bf16 operands, fp32 accumulation, and fp32 score output targets the missing operation directly. The hard stop conditions are exactly right: keep it only if all three shapes pass `calc_diff <= 5e-6`, `shapes_regressed == 0`, and ratio improves.

Scope/reward-hacking check on A: **no red flag if implemented narrowly.** A custom Triton kernel in `candidate.py` or `--candidate` is an accepted candidate-local optimization. It computes the same QK logits more efficiently; it does not change inputs, tolerances, reference, timing, cost model, or output semantics. Shape branching/fallback is allowed under this harness.

Guardrails:
- Keep the existing fp32-QK torch path as the safe fallback, not a broken bf16 fallback.
- Do not use `AITER_TRITON_ONLY=1` to make a bf16 candidate pass against the degraded torch reference; that would be reward hacking.
- Do not cache gathered/transposed per-input tensors across warmup/timed calls to dodge timed layout work.
- Do not modify harness/reference/task metadata.
- Verify with the real default repeat, all `M = 1024, 2048, 4096`, under `AITER_TRITON_ONLY=0`.

I would not pick B yet. I would not chase C unless A fails: hipBLASLt/aiter direct calls are not an evident smaller route to bf16-in/fp32-out batched QK, and a full fused attention kernel is larger and riskier than the QK-only Triton lever.
