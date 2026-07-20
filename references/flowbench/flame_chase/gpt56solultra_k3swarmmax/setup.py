"""The ``flame_chase/gpt56solultra_k3swarmmax`` flow: Codex and swarm-mode Kimi Code taking turns Ralph-style until the task is done."""

from pathlib import Path

from flowbench.workspace_utils import KIMI_DIR, copy_files


def setup(work_dir: Path) -> None:
    flow_dir = Path(__file__).resolve().parent
    copy_files(
        flow_dir,
        work_dir,
        [
            ("run.sh", "run.sh"),
            ("run.py", "run.py"),
            ("config.toml", f"{KIMI_DIR}/config.toml"),
            ("kimi_server.py", "kimi_server.py"),
        ],
    )
