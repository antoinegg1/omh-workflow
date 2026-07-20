"""The ``flame_chase/fable5xhigh_gpt56solxhigh`` flow: Claude Code and Codex taking turns Ralph-style until the task is done."""

from pathlib import Path

from flowbench.workspace_utils import copy_files


def setup(work_dir: Path) -> None:
    copy_files(Path(__file__).resolve().parent, work_dir, [("run.sh", "run.sh")])
