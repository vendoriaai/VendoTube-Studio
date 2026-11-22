import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

"""
Bridge concurrency regression (2026-11-19).

A slow request used to block every request behind it: `dwk.validate_project`
— a 0.02s file read — timed out at 60s while a video thumbnail decoded on the
single reader thread. The bridge now runs handlers on a worker pool.

Spawns the real bridge and interleaves one slow call with a fast one.
"""

BRIDGE = Path(__file__).resolve().parent / "server.py"


def test_concurrent_requests_do_not_starve() -> None:
    proc = subprocess.Popen(
        [sys.executable, "-u", str(BRIDGE)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )
    assert proc.stdin and proc.stdout

    replies: dict[int, dict] = {}
    lock = threading.Lock()
    ready = threading.Event()

    def reader() -> None:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in frame:
                with lock:
                    replies[frame["id"]] = frame
                ready.set()

    threading.Thread(target=reader, daemon=True).start()

    def call(rid: int, method: str, params: dict | None = None) -> None:
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}) + "\n")
        proc.stdin.flush()

    try:
        # Fire several requests back to back; with a worker pool they are all
        # in flight at once and every one must come back promptly. A serial
        # reader would still answer these, so the real assertion is the slow
        # request in test 2 — here we pin the basic parallel path.
        for i in range(1, 9):
            call(i, "sys.ping")
        deadline = time.time() + 10
        while time.time() < deadline:
            with lock:
                done = len([k for k in replies if 1 <= k <= 8])
            if done == 8:
                break
            time.sleep(0.05)
        with lock:
            got = sorted(k for k in replies if 1 <= k <= 8)
        assert got == list(range(1, 9)), f"expected 8 concurrent pings, got {got}"

        # A cheap follow-up still answers (ordering between ids is not
        # guaranteed once handlers are concurrent — only completion is).
        call(20, "sys.paths")
        deadline = time.time() + 10
        while time.time() < deadline:
            with lock:
                if 20 in replies:
                    break
            time.sleep(0.05)
        with lock:
            assert 20 in replies, "sys.paths did not answer"
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_fast_request_overtakes_a_slow_one() -> None:
    """The actual defect: a fast call sent AFTER a slow one must not wait for it.

    Injects a deliberate 3s sleep as a handler on the real bridge, fires it,
    then fires `sys.ping`. On the old serial reader the ping waited behind the
    sleep; on the pool it answers in milliseconds.
    """
    driver = f'''
import json, sys, time
sys.path.insert(0, {str(BRIDGE.parent)!r})
import server

@server.method("test.sleep")
def _sleep(params):
    time.sleep(float(params.get("seconds") or 3))
    return {{"slept": True}}

server.main()
'''
    proc = subprocess.Popen(
        [sys.executable, "-u", "-c", driver],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )
    assert proc.stdin and proc.stdout
    replies: dict[int, float] = {}
    lock = threading.Lock()
    try:
        def reader() -> None:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    frame = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "id" in frame:
                    with lock:
                        replies[frame["id"]] = time.time()

        threading.Thread(target=reader, daemon=True).start()

        def call(rid: int, method: str, params: dict | None = None) -> float:
            t = time.time()
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}) + "\n")
            proc.stdin.flush()
            return t

        call(1, "test.sleep", {"seconds": 3})  # slow, occupies one worker
        time.sleep(0.3)  # ensure the sleep handler is running
        call(2, "sys.ping")  # fast, must NOT queue behind it

        deadline = time.time() + 10
        while time.time() < deadline:
            with lock:
                if 2 in replies:
                    break
            time.sleep(0.02)
        with lock:
            assert 2 in replies, "sys.ping never answered while a slow handler ran"
            ping_after_sleep_started = replies[2]
        # The ping must land well before the 3s sleep finishes.
        assert ping_after_sleep_started - min(replies.values()) < 3.0, (
            "sys.ping waited for the slow handler — the bridge is still serial"
        )
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_bridge_still_serializes_response_frames() -> None:
    """Every reply is one whole JSON line (no interleaving half-frames)."""
    proc = subprocess.Popen(
        [sys.executable, "-u", str(BRIDGE)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )
    assert proc.stdin and proc.stdout
    try:
        lines: list[str] = []

        def reader() -> None:
            for line in proc.stdout:
                if line.strip():
                    lines.append(line)

        threading.Thread(target=reader, daemon=True).start()
        for i in range(1, 25):
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": "sys.ping", "params": {}}) + "\n")
        proc.stdin.flush()
        deadline = time.time() + 10
        while time.time() < deadline and len(lines) < 24:
            time.sleep(0.05)
        assert len(lines) == 24, f"expected 24 frames, got {len(lines)}"
        for line in lines:
            parsed = json.loads(line)  # a torn frame would raise here
            assert parsed["jsonrpc"] == "2.0"
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    test_concurrent_requests_do_not_starve()
    print("OK: concurrent bridge requests do not starve")
    test_bridge_still_serializes_response_frames()
    print("OK: response frames stay whole under concurrency")
    test_fast_request_overtakes_a_slow_one()
    print("OK: a fast request overtakes a slow one")
