#!/usr/bin/env python3
"""Standalone round-trip test for the Studio Bridge.

Spawns bridge/server.py on a fresh interpreter, speaks newline-delimited
JSON-RPC over stdio, and verifies the M0 exit-criteria methods:
sys.ping, sys.paths, dwk.init_project, dwk.validate_project.

Run:  bridge/.venv/Scripts/python bridge/test_bridge.py
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

EXPECTED_LAYOUT = [
    "project.yml",
    "research/sources.csv",
    "research/evidence_ledger.csv",
    "research/assets_to_download.csv",
    "production/shot_list.csv",
    "production/script.md",
]


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="vendotube-bridge-test-"))
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

    def request(method: str, params: dict | None = None, timeout: float = 120.0) -> dict:
        nonlocal next_id
        next_id += 1
        rid = next_id
        frame = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            frame["params"] = params
        proc.stdin.write(json.dumps(frame) + "\n")
        proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = proc.stdout.readline()
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

    # 1. ping
    pong = request("sys.ping")
    print(f"ping -> {pong}")
    if not pong.get("ok"):
        failures.append("sys.ping not ok")
    if not pong.get("dwk_loaded"):
        failures.append(f"DWK not loaded: {pong.get('dwk_error')}")

    # 2. paths (needs DWK for ffmpeg resolution)
    paths = request("sys.paths")
    print(f"paths -> ffmpeg={paths.get('ffmpeg')}")
    if not paths.get("ffmpeg") or str(paths.get("ffmpeg")).startswith("unavailable"):
        failures.append(f"ffmpeg not resolved: {paths.get('ffmpeg')}")

    # 3. init_project → DWK layout on disk
    project_path = root / "sample-project"
    init = request(
        "dwk.init_project",
        {"path": str(project_path), "title": "Bridge Test Film", "fps": 60, "runtime": 90, "language": "en"},
    )
    print(f"init -> {init}")
    for rel in EXPECTED_LAYOUT:
        if not (project_path / rel).exists():
            failures.append(f"missing after init: {rel}")

    # 3b. auto mode: no runtime → project.yml omits target_runtime_seconds
    auto_path = root / "sample-project-auto"
    request(
        "dwk.init_project",
        {"path": str(auto_path), "title": "Auto Runtime Film", "fps": 60, "runtime": None, "language": "en"},
    )
    auto_yml = (auto_path / "project.yml").read_text(encoding="utf-8")
    if "target_runtime_seconds" in auto_yml:
        failures.append("auto init still wrote target_runtime_seconds")
    else:
        print("init auto -> target_runtime_seconds omitted (Director decides)")

    # 4. validate_project → structured report round-trip
    report = request("dwk.validate_project", {"project_path": str(project_path)})
    print(f"validate -> valid={report.get('valid')} errors={len(report.get('errors', []))} warnings={len(report.get('warnings', []))}")
    if "project" not in report or "valid" not in report:
        failures.append(f"validation report malformed: keys={sorted(report)[:8]}")
    if not (project_path / "qc" / "validation_report.json").exists():
        failures.append("validation report file not written")

    # 5. unknown method → JSON-RPC error
    try:
        request("nope.nope")
        failures.append("unknown method did not raise")
    except RuntimeError as exc:
        print(f"unknown method -> error (expected): {str(exc)[:60]}...")

    # 6. M1: SSRF guard refuses private/loopback targets
    for bad in ["http://127.0.0.1/x", "http://localhost/x", "http://10.0.0.1/x", "http://169.254.169.254/meta", "ftp://example.com/x"]:
        try:
            request("fetch.metadata", {"url": bad})
            failures.append(f"SSRF guard did not refuse {bad}")
        except RuntimeError:
            print(f"ssrf guard -> refused {bad} (expected)")

    # 7. M1: ledger append → rights approval → real gated download batch
    src = request("ledger.append_sources", {"project_path": str(project_path), "rows": [
        {"title": "Cahokia - Wikipedia", "url": "https://en.wikipedia.org/wiki/Cahokia", "source_type": "tertiary orientation only"},
    ]})
    if src["count"] != 1:
        failures.append(f"append_sources count={src['count']}")
    sid = src["rows"][0]["source_id"]
    print(f"ledger.append_sources -> {sid}")

    claim = request("ledger.append_claims", {"project_path": str(project_path), "rows": [
        {"claim_text": "Cahokia was a large pre-Columbian settlement near the Mississippi River.",
         "source_id": sid, "locator": "article lead", "confidence": "high"},
    ]})
    if claim["count"] != 1:
        failures.append(f"append_claims count={claim['count']}")
    print(f"ledger.append_claims -> {claim['rows'][0]['claim_id']}")

    # 7b. Unicode round-trip (regression: Windows charmap codec crashed the
    # response frame when ledger content held non-cp1252 chars, e.g. CJK
    # punctuation harvested from sources — 'charmap' UnicodeEncodeError).
    request("ledger.append_claims", {"project_path": str(project_path), "rows": [
        {"claim_text": "来源标题包含全角冒号：em dash—smart “quotes” and emoji-adjacent chars.",
         "source_id": sid, "locator": "regression §1", "confidence": "high"},
    ]})
    digest = request("ledger.digest", {"project_path": str(project_path)})
    digest_text = json.dumps(digest, ensure_ascii=False)
    if "：" not in digest_text or "“" not in digest_text:
        failures.append("ledger.digest lost Unicode content (charmap regression)")
    print("ledger.digest unicode round-trip -> ok")

    media = request("dwk.discover_media", {"project_path": str(project_path), "query": "Monks Mound Cahokia", "provider": "commons", "limit": 4})
    if media["count"] < 1:
        failures.append("discover_media returned no candidates (network?)")
    rows = media["rows"][:2]
    for row in rows:
        row["source_id"] = sid
    added = request("ledger.append_assets", {"project_path": str(project_path), "rows": rows})
    print(f"discover_media + append_assets -> {added['count']} candidates")
    if added["count"] < 1:
        failures.append("append_assets saved no rows")

    # G-C: approve the first candidate (human gate — in-app this is a click)
    first_id = added["rows"][0]["asset_id"]
    changed = request("ledger.set_rights", {"project_path": str(project_path), "asset_ids": [first_id], "rights_status": "approved"})
    if changed["changed"] != 1:
        failures.append(f"set_rights changed={changed['changed']}")

    # G-B: DWK hard-gated downloader (subprocess, CLI-identical)
    dl = request("dwk.download_assets", {"project_path": str(project_path)})
    print(f"download_assets (Commons) -> exit={dl['exit_code']} added={dl['added_count']}"
          + ("" if dl["added_count"] >= 1 else " [info: third-party rate limit possible]"))

    # 8. assets.list reflects the merged view (counts asserted after step 9)
    assets_view = request("assets.list", {"project_path": str(project_path)})
    print(f"assets.list -> {len(assets_view['candidates'])} candidates, {assets_view['downloaded_count']} downloaded")

    # 9. deterministic gated download (rate-limit independent): a small public-domain
    # text file via the same hard gate (approved + allow-listed license only).
    det = request("ledger.append_assets", {"project_path": str(project_path), "rows": [{
        "provider": "test", "asset_page_url": "https://github.com/python/cpython/blob/main/LICENSE",
        "download_url": "https://raw.githubusercontent.com/python/cpython/main/LICENSE",
        "filename": "cpython-license.txt", "media_type": "document", "license": "CC0 (test fixture)",
        "creator": "Python Software Foundation", "notes": "synthetic fixture row for gate mechanics; content is PSF-licensed text",
    }]})
    if det["count"] == 1:
        det_id = det["rows"][0]["asset_id"]
        request("ledger.set_rights", {"project_path": str(project_path), "asset_ids": [det_id], "rights_status": "approved"})
        dl2 = request("dwk.download_assets", {"project_path": str(project_path)})
        if dl2["added_count"] < 1:
            failures.append(f"deterministic download failed: {dl2['errors'][-200:]!r}")
        else:
            saved = dl2["added"][0].get("saved_path", "")
            if not (project_path / saved).exists() or not dl2["added"][0].get("sha256"):
                failures.append(f"deterministic download incomplete: {saved!r}")
            else:
                print(f"deterministic gate download -> {saved} ({dl2['added'][0].get('bytes')} bytes, sha256 ok)")
        final_view = request("assets.list", {"project_path": str(project_path)})
        if final_view["downloaded_count"] < 1:
            failures.append("assets.list downloaded_count < 1 after deterministic download")
    else:
        failures.append("deterministic candidate not appended")

    # 10. shot list serialization (regression: integer 0 start_frame was
    # serialized as "" by the 0-falsy `x or ""` coercion, so the required
    # first row's start_frame hit dwk.validate_project as an empty cell and
    # produced "Shot row 1: start_frame/end_frame must be integers").
    (project_path / "media" / "graphics").mkdir(parents=True, exist_ok=True)
    (project_path / "media" / "images").mkdir(parents=True, exist_ok=True)
    (project_path / "media" / "graphics" / "card_s1_00.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>', encoding="utf-8"
    )
    (project_path / "media" / "images" / "card-test.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>', encoding="utf-8"
    )
    written = request("dwk.write_shot_list", {"project_path": str(project_path), "rows": [
        {"start_frame": 0, "end_frame": 120, "asset_path": "media/graphics/card_s1_00.svg", "asset_type": "image",
         "source_in": "", "source_id": "", "claim_id": "", "visual_label": "title card", "notes": "designed graphic"},
        {"start_frame": 120, "end_frame": 240, "asset_path": "media/images/card-test.svg", "asset_type": "image",
         "source_in": "", "source_id": sid, "claim_id": claim["rows"][0]["claim_id"], "visual_label": "fixture still", "notes": "test row"},
    ]})
    if written.get("count") != 2:
        failures.append(f"write_shot_list count={written.get('count')}")
    first_data_row = (project_path / "production" / "shot_list.csv").read_text(encoding="utf-8-sig").splitlines()[1]
    if not first_data_row.startswith("0,"):
        failures.append(f"shot row 1 start_frame serialized as {first_data_row.split(',')[0]!r} (0-falsy regression)")
    report2 = request("dwk.validate_project", {"project_path": str(project_path)})
    shot_errors = [e for e in report2.get("errors", []) if "Shot row" in e]
    if shot_errors:
        failures.append(f"validate_project shot errors: {shot_errors}")
    print(f"write_shot_list + validate -> rows={written.get('count')}, shot errors={len(shot_errors)}, valid={report2.get('valid')}")

    proc.stdin.close()
    proc.wait(timeout=10)

    if failures:
        print("\nFAIL:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nOK: bridge round-trip passed (ping, paths, init_project layout, validate_project report, error handling)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
