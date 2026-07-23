- [P1] Avoid defaulting to ROCm before candidates are ported — /home/lichangye/kernel-harness-amd/testbench/harness/backends/registry.py:48-48
  With no `KERNEL_HARNESS_*` overrides, this now selects ROCm/MI300X for every task, but most task-local `candidate.py` files were not changed and still import/launch CUDA DeepGEMM (for example `q_b_prefill` uses `deep_gemm.fp8_gemm_nt`). On a ROCm-only runner `./run.sh` for those tasks fails during candidate import instead of providing the reference-like baseline, so either keep CUDA as the default until the candidates are ported or regenerate the default candidates to call the selected backend reference.

- [P1] Use the harness reference for the ROCm fallback — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/index_score_prefill/candidate.py:72-73
  When the fast path is skipped (for example gluon active, non-gfx942, or a changed heuristic), this fallback calls DeepGEMM rather than the selected ROCm oracle (`glm52_ops.reference`/AITER). On MI300X installations without DeepGEMM the module already fails at import, and even with DeepGEMM installed the fallback no longer matches the backend described in `problem.json`, so this should fall back through the harness reference instead.
The patch switches the default harness to ROCm while leaving many default candidates tied to CUDA DeepGEMM, and one new ROCm candidate still falls back through DeepGEMM instead of the harness reference. These issues can break normal task runs on the intended MI300X backend.

Full review comments:

- [P1] Avoid defaulting to ROCm before candidates are ported — /home/lichangye/kernel-harness-amd/testbench/harness/backends/registry.py:48-48
  With no `KERNEL_HARNESS_*` overrides, this now selects ROCm/MI300X for every task, but most task-local `candidate.py` files were not changed and still import/launch CUDA DeepGEMM (for example `q_b_prefill` uses `deep_gemm.fp8_gemm_nt`). On a ROCm-only runner `./run.sh` for those tasks fails during candidate import instead of providing the reference-like baseline, so either keep CUDA as the default until the candidates are ported or regenerate the default candidates to call the selected backend reference.

- [P1] Use the harness reference for the ROCm fallback — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/index_score_prefill/candidate.py:72-73
  When the fast path is skipped (for example gluon active, non-gfx942, or a changed heuristic), this fallback calls DeepGEMM rather than the selected ROCm oracle (`glm52_ops.reference`/AITER). On MI300X installations without DeepGEMM the module already fails at import, and even with DeepGEMM installed the fallback no longer matches the backend described in `problem.json`, so this should fall back through the harness reference instead.
