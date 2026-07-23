- [P1] Do not bypass the documented B200 DSA gate — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/dsa_prefill_attn/candidate.py:93-94
  When this task is run through its documented `run.sh`/default B200 backend, `torch.version.hip` is `None`, so this branch always throws and `run()` falls back to `flash_mla_sparse_fwd`, which is exactly the baseline. That leaves every shape with no genuine speedup, so the performance gate has zero real wins; either the task runner/contract needs to select ROCm or this candidate needs a B200 fast path.

- [P1] Do not make the B200 score path a no-op — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/index_score_prefill/candidate.py:80-83
  Under the documented B200/default run for `index_score_prefill`, this ROCm/AITER internal import is unavailable or later rejected by the `gfx942` guard, and `run()` catches that and calls `_reference`, the same `deep_gemm.fp8_mqa_logits` baseline as before. In that environment the optimized path never runs, so the candidate cannot produce a real winning shape for the gate.
Two committed candidates are guarded to ROCm-only paths while their per-task documented/default gate is B200, causing them to fall back to the reference and provide no real speedup.

Full review comments:

- [P1] Do not bypass the documented B200 DSA gate — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/dsa_prefill_attn/candidate.py:93-94
  When this task is run through its documented `run.sh`/default B200 backend, `torch.version.hip` is `None`, so this branch always throws and `run()` falls back to `flash_mla_sparse_fwd`, which is exactly the baseline. That leaves every shape with no genuine speedup, so the performance gate has zero real wins; either the task runner/contract needs to select ROCm or this candidate needs a B200 fast path.

- [P1] Do not make the B200 score path a no-op — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/index_score_prefill/candidate.py:80-83
  Under the documented B200/default run for `index_score_prefill`, this ROCm/AITER internal import is unavailable or later rejected by the `gfx942` guard, and `run()` catches that and calls `_reference`, the same `deep_gemm.fp8_mqa_logits` baseline as before. In that environment the optimized path never runs, so the candidate cannot produce a real winning shape for the gate.
