# Source before running GLM-5.2 ROCm KDA commands.
source /home/lichangye/rocm_env.sh
export KERNEL_HARNESS_PLATFORM="${KERNEL_HARNESS_PLATFORM:-rocm}"
export KERNEL_HARNESS_PROFILE="${KERNEL_HARNESS_PROFILE:-amd-mi300x}"
export KERNEL_HARNESS_PROVIDER="${KERNEL_HARNESS_PROVIDER:-aiter-torch-reference}"
export KERNEL_HARNESS_TIMER="${KERNEL_HARNESS_TIMER:-event}"
# Full AITER CK/HIP ops are intentionally not built in this recovered env.
# Keep SGLang on its verified ROCm/Triton/reference path by default.
export SGLANG_USE_AITER="${KDA_SGLANG_USE_AITER:-0}"
