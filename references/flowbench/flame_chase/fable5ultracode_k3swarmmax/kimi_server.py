"""Client for swarm-mode Kimi Code sessions over the local ``kimi server`` REST API.

Kimi Code's print mode has no swarm-mode switch, so the ``k3_swarm_max``
flows drive the server's REST API (self-documented at ``GET /openapi.json``)
instead: create a session, apply the swarm agent profile, prompt, and poll.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request
from typing import Any

_BASE_URL = "http://127.0.0.1:47923/api/v1"

#: Agent profile the swarm flows run with: K3 at max effort, swarm mode on,
#: and auto permission (the same permission print mode forces headless).
SWARM_AGENT_CONFIG: dict[str, Any] = {
    "model": "kimi-code/k3",
    "thinking": "max",
    "permission_mode": "auto",
    "swarm_mode": True,
}


def ensure_running() -> None:
    """Starts (or reuses) the local Kimi server daemon and waits until healthy."""
    subprocess.run(
        [
            "kimi",
            "server",
            "run",
            "--keep-alive",
            "--port",
            "47923",
            "--dangerous-bypass-auth",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def call(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    request = urllib.request.Request(
        _BASE_URL + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(request) as response:
        payload = json.load(response)
    if payload["code"] != 0:
        raise RuntimeError(f"{method} {path} failed: {payload['msg']}")
    return payload["data"]


def create_session(agent_config: dict[str, Any]) -> str:
    """Creates a session in the working directory and applies the agent profile."""
    session_id = call("POST", "/sessions", {"metadata": {"cwd": os.getcwd()}})["id"]
    call("POST", f"/sessions/{session_id}/profile", {"agent_config": agent_config})
    return session_id


def session_ids() -> list[str]:
    """Existing session ids, most recently updated first."""
    return [session["id"] for session in call("GET", "/sessions")["items"]]


def prompt(session_id: str, text: str) -> None:
    call(
        "POST",
        f"/sessions/{session_id}/prompts",
        {"content": [{"type": "text", "text": text}]},
    )


def wait_idle(session_id: str) -> None:
    """Blocks until the session's current turn (including subagents) finishes."""
    while call("GET", f"/sessions/{session_id}/status")["busy"]:
        time.sleep(5)


def last_assistant_text(session_id: str) -> str:
    """The text of the session's most recent assistant message."""
    for message in reversed(call("GET", f"/sessions/{session_id}/messages")["items"]):
        if message["role"] == "assistant":
            return "".join(
                block["text"] for block in message["content"] if block["type"] == "text"
            )
    return ""
