- [P3] Read archived results when rebuilding plots — /home/lichangye/kernel-harness-amd/archive/0720-Best-GLM-52/lichangye/token_perf/build_token_perf.py:105-105
  When this rebuild script is run from a fresh checkout of the archive, the `runs/glm52/...` directories it reads here are not part of the archived artifacts, while the matching `result.json` files are committed under `archive/0720-Best-GLM-52/lichangye/<task>/result.json`. This makes the documented rebuild command depend on the author's local run cache instead of the archive contents.
The main harness changes appear structurally consistent, but the new archive rebuild script is not self-contained and will fail outside the author's local run directory despite the needed result JSONs being archived.

Review comment:

- [P3] Read archived results when rebuilding plots — /home/lichangye/kernel-harness-amd/archive/0720-Best-GLM-52/lichangye/token_perf/build_token_perf.py:105-105
  When this rebuild script is run from a fresh checkout of the archive, the `runs/glm52/...` directories it reads here are not part of the archived artifacts, while the matching `result.json` files are committed under `archive/0720-Best-GLM-52/lichangye/<task>/result.json`. This makes the documented rebuild command depend on the author's local run cache instead of the archive contents.
