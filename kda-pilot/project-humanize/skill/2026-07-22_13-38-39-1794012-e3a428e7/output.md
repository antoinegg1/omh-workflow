FAIL: verification is blocked, not failed on evidence content.

Concrete gaps:
- I could not read `.humanize/rlcr/2026-07-22_13-18-49/preflight-evidence.md`.
- I could not parse `/opt/devmachine/lichangye/tmp/kda_glm52_smoke_r0_20260722_133258.json`.
- I could not verify AC-1 live state: clean worktree, base ref hash, `rocm_env.sh` exports, PATH tools, or humanize plugin list.
- I could not verify AC-2 smoke fields.

Every local command failed before execution with:

```text
bwrap: Failed to make / slave: Permission denied
```

I would not proceed to target selection until the evidence is independently checked or the command sandbox is fixed.
