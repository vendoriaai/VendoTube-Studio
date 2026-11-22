#!/usr/bin/env python3
"""Visual QC Layer 0 (M7) E2E: deterministic fixture film with PLANTED defects.

Synthesizes a 12 s master with known defect timestamps via ffmpeg lavfi, then
drives the real bridge methods the pipeline uses:

  timeline        0–3s      3–5s       5–9s       9–12s
  picture         testsrc2  BLACK      testsrc2   SOLID BLUE (frozen)
  audio           sine      sine       SILENCE    sine
  expected cuts   —         ~3s        ~5s        ~9s

scan_master must report black ≈ [3, 5], silence ≈ [4, 8], freeze covering the
blue segment, and cuts ≈ {3, 5, 9} — exactly those timestamps and nothing
else. sample_frames must write the requested JPEGs into qc/visual_frames/.

Run:  python bridge/test_qc_scan.py   (skips when ffmpeg is unavailable)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent
SERVER = BRIDGE_DIR / "server.py"


def ffmpeg_available() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=30)
        return True
    except (OSError, subprocess.TimeoutExpired):
        return False


def build_fixture() -> Path:
    """One lavfi command: video concat (moving/black/moving/frozen) + audio
    concat (sine/silence/sine), 12 s total, 640×360 @ 30 fps, aac audio.
    subprocess uses a fixed argv list (shell=False) — no user input anywhere."""
    out = Path(tempfile.mkdtemp(prefix="vendotube-qc-fixture-")) / "master.mp4"
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3",
        "-f", "lavfi", "-i", "color=c=black:size=640x360:rate=30:duration=2",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4",
        "-f", "lavfi", "-i", "color=c=blue:size=640x360:rate=30:duration=3",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
        "-filter_complex",
        "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v];"
        "[4:a][5:a][6:a]concat=n=3:v=0:a=1[a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        "-t", "12",
        str(out),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300, shell=False)
    if proc.returncode != 0 or not out.is_file():
        raise RuntimeError(f"fixture build failed: {(proc.stderr or '')[-400:]}")
    return out


def main() -> int:
    if not ffmpeg_available():
        print("SKIP: ffmpeg not on PATH")
        return 0
    root = Path(tempfile.mkdtemp(prefix="vendotube-qc-test-"))
    proc = subprocess.Popen(
        [sys.executable, str(SERVER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    assert proc.stdin and proc.stdout

    next_id = 0
    failures: list[str] = []

    def request(method: str, params: dict | None = None, timeout: float = 600.0) -> dict:
        nonlocal next_id
        next_id += 1
        rid = next_id
        frame = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            frame["params"] = params
        proc.stdin.write(json.dumps(frame) + "\n")  # type: ignore[union-attr]
        proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = proc.stdout.readline()  # type: ignore[union-attr]
            if not line:
                raise RuntimeError(f"bridge closed stdout: {proc.stderr.read() if proc.stderr else ''}")
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)
            if msg.get("id") == rid:
                if "error" in msg:
                    raise RuntimeError(f"{method} failed: {msg['error']}")
                return msg["result"]
        raise TimeoutError(f"{method} timed out after {timeout}s")

    try:
        # 0. project shell (paths resolve against it)
        project_path = root / "qc-project"
        request("dwk.init_project", {"path": str(project_path), "title": "QC Fixture", "fps": 30, "runtime": 12, "language": "en"})

        fixture = build_fixture()
        (project_path / "delivery").mkdir(exist_ok=True)
        (project_path / "delivery" / "master.mp4").write_bytes(fixture.read_bytes())
        media_rel = "delivery/master.mp4"

        # 1. scan_master: detectors report the planted defects exactly.
        scan = request("qc.scan_master", {"project_path": str(project_path), "media_path": media_rel}, timeout=600)
        print(f"scan -> duration={scan.get('duration_s')} black={scan.get('black')} freeze={scan.get('freeze')} silence={scan.get('silence')} cuts={scan.get('cuts')}")

        if abs(scan.get("duration_s", 0) - 12.0) > 0.5:
            failures.append(f"duration_s={scan.get('duration_s')} (want ≈12)")

        def covers(ranges: list[dict], from_s: float, to_s: float) -> bool:
            return any(r["from_s"] <= from_s + 0.4 and r["to_s"] >= to_s - 0.4 for r in ranges)

        if not covers(scan.get("black") or [], 3.2, 4.8):
            failures.append(f"black does not cover ~[3,5]: {scan.get('black')}")
        # Exactly ONE black range: the planted one (from_s>0.5 alone would
        # wrongly re-flag the planted 3-5s range itself).
        black_ranges = scan.get("black") or []
        if len(black_ranges) != 1:
            failures.append(f"expected exactly 1 black range, got: {black_ranges}")

        if not covers(scan.get("silence") or [], 4.2, 7.8):
            failures.append(f"silence does not cover ~[4,8]: {scan.get('silence')}")

        freeze = scan.get("freeze") or []
        # The blue segment is a static frame -> frozen; the black segment reads
        # as frozen too (no picture change) — both are TRUE findings for L0.
        if not covers(freeze, 9.5, 11.5):
            failures.append(f"freeze does not cover the frozen blue segment ~[9,12]: {freeze}")

        cuts = scan.get("cuts") or []

        def has_cut(t: float) -> bool:
            return any(abs(c - t) <= 0.5 for c in cuts)

        for expected in (3.0, 5.0, 9.0):
            if not has_cut(expected):
                failures.append(f"missing cut at ~{expected}: {cuts}")
        stray = [c for c in cuts if not any(abs(c - e) <= 0.5 for e in (3.0, 5.0, 9.0))]
        if stray:
            failures.append(f"stray cuts beyond the planted ones: {stray}")

        sha = scan.get("sha256") or ""
        if len(sha) != 64:
            failures.append(f"sha256 malformed: {sha[:20]}")

        # 2. qc.sample_frames: stills land in the cache with the right names.
        frames = request(
            "qc.sample_frames",
            {"project_path": str(project_path), "media_path": media_rel, "sha8": sha[:8], "times": [1.0, 4.0, 10.5]},
            timeout=300,
        )
        print(f"sample_frames -> dir={frames.get('dir')} frames={frames.get('frames')}")
        if len(frames.get("frames") or []) != 3:
            failures.append(f"sample_frames wrote {len(frames.get('frames') or [])}/3 frames")
        for rel in frames.get("frames") or []:
            p = project_path / rel
            if not p.is_file() or p.stat().st_size < 1000:
                failures.append(f"frame file missing/too small: {rel} ({p.stat().st_size if p.exists() else 0} bytes)")
        if not (project_path / "qc" / "visual_frames" / sha[:8]).is_dir():
            failures.append("qc/visual_frames/<sha8>/ cache dir missing")

        # 3. budget ceiling: > 600 times must be refused.
        try:
            request("qc.sample_frames", {"project_path": str(project_path), "media_path": media_rel, "sha8": sha[:8], "times": [0.5] * 601})
            failures.append("sample_frames budget not enforced")
        except RuntimeError as exc:
            print(f"budget -> refused (expected): {str(exc)[:60]}")

    finally:
        try:
            proc.stdin.close()  # type: ignore[union-attr]
        except Exception:
            pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    if failures:
        print(f"\nFAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nqc-scan E2E: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
