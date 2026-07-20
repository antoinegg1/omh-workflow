"""One swarm-mode K3 turn on a fresh session; ``run.sh`` alternates it with Claude Code Ralph-style."""

from pathlib import Path

import kimi_server


def main() -> None:
    kimi_server.ensure_running()
    session_id = kimi_server.create_session(kimi_server.SWARM_AGENT_CONFIG)
    kimi_server.prompt(session_id, Path("TASK.md").read_text())
    kimi_server.wait_idle(session_id)


if __name__ == "__main__":
    main()
