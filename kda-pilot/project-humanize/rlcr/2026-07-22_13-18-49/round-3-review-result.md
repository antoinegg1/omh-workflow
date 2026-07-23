- [P1] Guard ROCm-only sparse MLA path on CUDA — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/dsa_prefill_attn/candidate.py:117-117
  When this task is run under the default cuda/cuda-b200 backend, this call now takes the PyTorch gather/einsum workaround for every valid input instead of the optimized `sgl_kernel.flash_mla_sparse_fwd` baseline. The optimization notes and measurements are specific to MI300X/TileLang, so on B200 this replaces the CUDA FlashMLA kernel with a much heavier PyTorch loop and will regress the default gate rather than falling back to the reference; add a platform/backend guard before taking the fast path.
The DSA candidate applies an MI300X-specific PyTorch workaround unconditionally, which breaks the default B200 behavior for that task. The other changes may be valid for the ROCm target, but this unguarded path makes the patch unsafe as a default candidate.

Review comment:

- [P1] Guard ROCm-only sparse MLA path on CUDA — /home/lichangye/kernel-harness-amd/testbench/tasks/glm52/dsa_prefill_attn/candidate.py:117-117
  When this task is run under the default cuda/cuda-b200 backend, this call now takes the PyTorch gather/einsum workaround for every valid input instead of the optimized `sgl_kernel.flash_mla_sparse_fwd` baseline. The optimization notes and measurements are specific to MI300X/TileLang, so on B200 this replaces the CUDA FlashMLA kernel with a much heavier PyTorch loop and will regress the default gate rather than falling back to the reference; add a platform/backend guard before taking the fast path.
