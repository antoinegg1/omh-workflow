"""The ``flame_chase/fable5max_k3max`` flow: Claude Code and Kimi Code taking turns Ralph-style until the task is done."""

from pathlib import Path

from flowbench.workspace_utils import KIMI_DIR, copy_files


def setup(work_dir: Path) -> None:
    flow_dir = Path(__file__).resolve().parent
    copy_files(
        flow_dir,
        work_dir,
        [("run.sh", "run.sh"), ("config.toml", f"{KIMI_DIR}/config.toml")],
    )
