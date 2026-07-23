- [P2] Avoid disabling the fast path on the B200 task — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/dsa_prefill_attn/candidate.py:84-85
  For the committed `dsa_prefill_attn` problem/default backend this task is still CUDA/B200, so this guard always raises and `run()` falls back to the original `flash_mla_sparse_fwd` reference. Since the gate requires at least one shape to beat the reference, this candidate cannot pass on the documented task unless the optimization is made applicable to B200 or the task/backend metadata is changed consistently.

- [P2] Do not gate the prefill score fast path to gfx942 — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/index_score_prefill/candidate.py:85-87
  The committed `index_score_prefill` task is still the CUDA/B200 problem, but this fast path only accepts gfx942/AITER; on B200 it raises here (or earlier on the AITER import) and `run()` returns the unchanged `deep_gemm.fp8_mqa_logits` reference. That leaves every B200 shape neutral, so the performance gate cannot be satisfied for the documented task.
Two modified candidates are ROCm/MI300X-only while their committed tasks remain B200/CUDA, so those fast paths are unreachable under the documented gate and fall back to the reference.

Full review comments:

- [P2] Avoid disabling the fast path on the B200 task — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/dsa_prefill_attn/candidate.py:84-85
  For the committed `dsa_prefill_attn` problem/default backend this task is still CUDA/B200, so this guard always raises and `run()` falls back to the original `flash_mla_sparse_fwd` reference. Since the gate requires at least one shape to beat the reference, this candidate cannot pass on the documented task unless the optimization is made applicable to B200 or the task/backend metadata is changed consistently.

- [P2] Do not gate the prefill score fast path to gfx942 — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/index_score_prefill/candidate.py:85-87
  The committed `index_score_prefill` task is still the CUDA/B200 problem, but this fast path only accepts gfx942/AITER; on B200 it raises here (or earlier on the AITER import) and `run()` returns the unchanged `deep_gemm.fp8_mqa_logits` reference. That leaves every B200 shape neutral, so the performance gate cannot be satisfied for the documented task.
