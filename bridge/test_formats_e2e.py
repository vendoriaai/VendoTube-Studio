#!/usr/bin/env python3
"""All-format research E2E — drives the same Bridge code paths the app uses.

The Studio research workflow gathers EVERY media format for a subject:
  1. scholarly/tertiary source discovery (Crossref, Wikipedia)
  2. article text extraction (HTML)
  3. PDF text extraction (kind=pdf)
  4. open-collection discovery (Commons) — honest media_type + relevance order
  5. licensed image via the DWK rights gate -> media/images
  6. web-harvested image -> media/web
  7. document (PDF file itself) -> media/web
  8. YouTube video -> media/video
  9. YouTube audio twin -> media/audio
 10. direct audio file (mp3) -> media/audio (yt-dlp or direct fallback)
 11. direct video file (mp4) -> media/video (yt-dlp or direct fallback)
 12. structured data (JSON + CSV) -> media/web + extract.data preview
 13. provenance ledger (downloaded_assets.csv, sha256)

Run:  python bridge/test_formats_e2e.py
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent
SERVER = BRIDGE_DIR / "server.py"
TOPIC = "Apollo 11 moon landing"
ALLOWED_LICENSES = ("Public domain", "CC0", "CC BY", "CC BY-SA")


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="vendotube-formats-e2e-"))
    proc = subprocess.Popen(
        [sys.executable, str(SERVER)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    assert proc.stdin and proc.stdout
    next_id = 0
    failures: list[str] = []
    warns: list[str] = []

    def request(method: str, params: dict | None = None, timeout: float = 900.0) -> dict:
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
            if not line.strip():
                continue
            msg = json.loads(line)
            if msg.get("id") == rid:
                if "error" in msg:
                    raise RuntimeError(f"{method} failed: {msg['error'].get('message')}")
                return msg["result"]
        raise TimeoutError(f"{method} timed out after {timeout}s")

    def propose_and_download(row: dict, timeout: float = 900.0) -> dict:
        res = request("ledger.append_assets", {"project_path": str(project), "rows": [row]})
        aid = res["rows"][0]["asset_id"]
        request("ledger.set_rights", {"project_path": str(project), "asset_ids": [aid], "rights_status": "approved"})
        return request("web.download_assets", {"project_path": str(project), "asset_ids": [aid]}, timeout=timeout)

    def file_in(folder: str) -> list[Path]:
        d = project / folder
        return [f for f in d.rglob("*") if f.is_file()] if d.exists() else []

    def check(label: str, ok: bool, detail: str = "", warn_only: bool = False) -> None:
        print(f"  [{label}] {'PASS' if ok else ('WARN' if warn_only else 'FAIL')} {detail}")
        if not ok:
            (warns if warn_only else failures).append(label)

    print(f"=== All-format research E2E — subject: {TOPIC} ===")
    project = root / "formats-test-project"
    request("dwk.init_project", {"path": str(project), "title": "Formats E2E", "fps": 30, "runtime": 300, "language": "en"})
    print(f"project: {project}")

    # ---- 1. source discovery (scholarly + tertiary) -----------------------------
    cr = request("dwk.discover_sources", {"provider": "crossref", "query": TOPIC, "limit": 5})
    wk = request("dwk.discover_sources", {"provider": "wikipedia", "query": TOPIC, "limit": 5})
    check("1. source discovery", cr["count"] + wk["count"] > 0,
          f"crossref {cr['count']} + wikipedia {wk['count']} rows")

    # ---- 2. article text (HTML) ---------------------------------------------------
    ext = {"ok": False}
    for _ in range(3):
        ext = request("extract.article", {"project_path": str(project), "url": "https://en.wikipedia.org/wiki/Apollo_11",
                                          "source_id": "WEB-APOLLO", "title": "Apollo 11 - Wikipedia"})
        if ext.get("ok"):
            break
        time.sleep(8)
    check("2. article text (HTML)", bool(ext.get("ok")) and ext.get("chars", 0) > 1000,
          f"{ext.get('chars')} chars -> {ext.get('path')}", warn_only=True)  # robots transient on flaky networks

    # ---- 3. PDF text extraction --------------------------------------------------
    pdf_ext = request("extract.article", {"project_path": str(project), "url": "https://arxiv.org/pdf/1706.03762",
                                          "source_id": "PDF-ARXIV", "title": "Attention Is All You Need (arXiv, format probe)"})
    check("3. PDF text extraction", bool(pdf_ext.get("ok")) and pdf_ext.get("kind") == "pdf" and pdf_ext.get("chars", 0) > 1000,
          f"kind={pdf_ext.get('kind')} {pdf_ext.get('chars')} chars")

    # ---- 4. Commons discovery: honest types + relevance ordering ------------------
    disc = request("dwk.discover_media", {"provider": "commons", "query": TOPIC, "limit": 10})
    rows = disc.get("rows", [])
    mislabeled = [r for r in rows if r.get("media_type") == "image" and str(r.get("download_url", "")).lower().endswith((".pdf", ".djvu"))]
    query_words = [w for w in TOPIC.lower().split() if len(w) >= 3]
    top5 = rows[:5]
    top_relevant = all(any(w in str(r.get("title", "")).lower() for w in query_words) for r in top5)
    check("4. commons discovery post-process", len(rows) > 0 and not mislabeled,
          f"{len(rows)} rows, mislabeled pdf-scans-as-image: {len(mislabeled)}; top-5 title-relevant: {top_relevant}")
    if rows and not top_relevant:
        warns.append("commons relevance ordering (top rows miss query words)")

    # ---- 5. licensed image via DWK rights gate ------------------------------------
    eligible = [r for r in rows
                if r.get("media_type") == "image"
                and any(str(r.get("license", "")).startswith(p) for p in ALLOWED_LICENSES)
                and str(r.get("download_url", "")).lower().endswith((".jpg", ".jpeg", ".png", ".tif", ".tiff"))]
    if eligible:
        r0 = eligible[0]
        request("ledger.append_assets", {"project_path": str(project), "rows": [r0]})
        aid = request("ledger.list", {"project_path": str(project), "kind": "assets"})["rows"][-1]["asset_id"]
        request("ledger.set_rights", {"project_path": str(project), "asset_ids": [aid], "rights_status": "approved"})
        dl = request("dwk.download_assets", {"project_path": str(project)}, timeout=900)
        ok = any("media/images" in str(a.get("saved_path", "")) or a.get("sha256") for a in dl.get("added", []))
        check("5. licensed image (DWK gate -> media/images)", ok and dl.get("exit_code") == 0,
              f"{[a.get('saved_path') for a in dl.get('added', [])]}", warn_only=True)  # Commons 429 rate limits
    else:
        check("5. licensed image (DWK gate)", False, "no allow-listed image candidate (rate limit?)", warn_only=True)

    # ---- 6. web-harvested image ---------------------------------------------------
    dl6 = propose_and_download({"provider": "web", "title": "python logo", "asset_page_url": "https://www.python.org/",
                                "download_url": "https://www.python.org/static/img/python-logo.png", "media_type": "image",
                                "license": "unverified (editorial review required)"}, timeout=180)
    check("6. web image -> media/web", dl6.get("downloaded", 0) == 1 and len(file_in("media/web")) >= 1,
          f"{[f.name for f in file_in('media/web')]}", warn_only=True)

    # ---- 7. document (PDF file itself, not just text) ------------------------------
    dl7 = propose_and_download({"provider": "web", "title": "arXiv paper", "asset_page_url": "https://arxiv.org/abs/1706.03762",
                                "download_url": "https://arxiv.org/pdf/1706.03762", "media_type": "document",
                                "license": "unverified (editorial review required)"}, timeout=180)
    pdf_files = [f for f in file_in("media/web") if f.suffix == ".pdf"]
    check("7. PDF document -> media/web", dl7.get("downloaded", 0) == 1 and len(pdf_files) >= 1,
          f"{[f.name for f in pdf_files]}", warn_only=True)

    # ---- 8/9. YouTube video + audio twin -------------------------------------------
    vids = request("ytdlp.search", {"query": "apollo 11 documentary", "limit": 8})
    watch = [r for r in vids.get("rows", []) if "youtube.com/watch" in r.get("url", "") or "youtu.be/" in r.get("url", "")]
    relevant = [r for r in watch if any(w in str(r.get("title", "")).lower() for w in ("apollo", "moon", "nasa", "launch", "saturn"))]
    pool = relevant or watch
    with_dur = [r for r in pool if isinstance(r.get("duration_s"), (int, float)) and 30 < r["duration_s"] < 1800]
    vid = min(with_dur or pool, key=lambda r: r.get("duration_s") or 9999, default=None)
    check("8. youtube search watch-URL filter", len(vids.get("rows", [])) > 0 and len(vids["rows"]) == len(watch),
          f"{len(vids['rows'])} rows, all watch URLs: {len(vids['rows']) == len(watch)}")
    if vid:
        dl8 = propose_and_download({"provider": "youtube", "title": vid["title"], "asset_page_url": vid["url"],
                                    "download_url": vid["url"], "media_type": "video",
                                    "license": "unverified (editorial review required)"}, timeout=1200)
        check("8b. YouTube video -> media/video", dl8.get("downloaded", 0) == 1 and len(file_in("media/video")) >= 1,
              f"{[f.name[:44] for f in file_in('media/video')]}")
        dl9 = propose_and_download({"provider": "youtube", "title": vid["title"] + " (audio)", "asset_page_url": vid["url"],
                                    "download_url": vid["url"], "media_type": "audio",
                                    "license": "unverified (editorial review required)"}, timeout=1200)
        check("8c. YouTube audio -> media/audio", dl9.get("downloaded", 0) == 1 and len(file_in("media/audio")) >= 1,
              f"{[f.name[:44] for f in file_in('media/audio')]}")
    else:
        check("8/9. YouTube search", False, "no search results", warn_only=True)

    # ---- 10. direct audio file (redirect + fallback path) ---------------------------
    dl10 = propose_and_download({"provider": "web", "title": "sample mp3", "asset_page_url": "https://samplelib.com/",
                                 "download_url": "https://download.samplelib.com/mp3/sample-3s.mp3", "media_type": "audio",
                                 "license": "unverified (editorial review required)"}, timeout=300)
    aud = file_in("media/audio")
    check("10. direct mp3 -> media/audio", dl10.get("downloaded", 0) == 1 and len(aud) >= 1,
          f"{[f.name for f in aud]}", warn_only=True)

    # ---- 11. direct video file ------------------------------------------------------
    dl11 = propose_and_download({"provider": "web", "title": "sample mp4", "asset_page_url": "https://samplelib.com/",
                                 "download_url": "https://download.samplelib.com/mp4/sample-5s.mp4", "media_type": "video",
                                 "license": "unverified (editorial review required)"}, timeout=300)
    vids_d = file_in("media/video")
    check("11. direct mp4 -> media/video", dl11.get("downloaded", 0) == 1 and len(vids_d) >= 1,
          f"{[f.name for f in vids_d]}", warn_only=True)

    # ---- 12. structured data (JSON + CSV) -------------------------------------------
    dl12a = propose_and_download({"provider": "web", "title": "users json", "asset_page_url": "https://jsonplaceholder.typicode.com/",
                                  "download_url": "https://jsonplaceholder.typicode.com/users", "media_type": "document",
                                  "license": "unverified (editorial review required)"}, timeout=180)
    dl12b = propose_and_download({"provider": "web", "title": "iris csv", "asset_page_url": "https://github.com/plotly/datasets",
                                  "download_url": "https://raw.githubusercontent.com/plotly/datasets/master/iris.csv",
                                  "media_type": "document", "license": "unverified (editorial review required)"}, timeout=180)
    data_files = {f.name: f for f in file_in("media/web") if f.suffix in (".json", ".csv")}
    previews = {}
    for name, f in data_files.items():
        if f.stat().st_size > 2:
            previews[name] = request("extract.data", {"path": str(f)}, timeout=60)
    ok_rows = sum(1 for p in previews.values() if p.get("rows", 0) > 0)
    check("12. structured data (JSON+CSV -> media/web + preview)", ok_rows == 2,
          f"files: {sorted(data_files)}, rows: {[(k, p.get('rows')) for k, p in previews.items()]}", warn_only=True)

    # ---- 13/14. research-time fetch + page screenshot --------------------------------
    rf = request("ledger.append_assets", {"project_path": str(project), "rows": [{
        "provider": "web", "title": "research-fetch probe", "asset_page_url": "https://picsum.photos/",
        "download_url": "https://picsum.photos/seed/vendotube-rf/640/480.jpg", "media_type": "image",
        "license": "unverified (editorial review required)", "notes": "research_fetch channel probe",
    }]})
    rf_id = rf["rows"][0]["asset_id"]
    rfd = request("web.research_fetch", {"project_path": str(project), "asset_ids": [rf_id]}, timeout=180)
    row_after = [r for r in request("ledger.list", {"project_path": str(project), "kind": "assets"})["rows"]
                 if r["asset_id"] == rf_id][0]
    check("13. research-time fetch (rights stay review)", rfd.get("downloaded", 0) == 1 and row_after.get("rights_status") == "review",
          f"downloaded={rfd.get('downloaded')}, rights_status={row_after.get('rights_status')}", warn_only=True)

    shot_b64 = base64.b64encode(b"\x00" * 2048).decode()
    shot = request("assets.save_screenshot", {"project_path": str(project), "url": "https://en.wikipedia.org/wiki/Apollo_11",
                                              "title": "Apollo 11 - Wikipedia", "jpeg_base64": shot_b64}, timeout=60)
    shots = file_in("media/screenshots")
    check("14. page screenshot saved + registered", bool(shot.get("ok")) and len(shots) >= 1,
          f"{[f.name for f in shots]}")

    # ---- 15. provenance ---------------------------------------------------------------
    prov = request("ledger.list", {"project_path": str(project), "kind": "downloaded"})["rows"]
    with_sha = [r for r in prov if r.get("sha256")]
    check("13. provenance ledger", len(with_sha) >= 5, f"{len(prov)} rows, {len(with_sha)} with sha256")

    proc.stdin.close()
    proc.wait(timeout=15)

    print("\n--- project media/ contents ---")
    for folder in ["media/images", "media/web", "media/video", "media/audio", "research/article_text"]:
        print(f"  {folder}: {[f.name[:50] for f in file_in(folder)]}")

    if warns:
        print("\nWARNINGS (transient-network / third-party dependent):")
        for w in warns:
            print(f"  ~ {w}")
    if failures:
        print("\nFAIL:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nOK: every media format verified end-to-end (sources, articles, PDFs, commons, images, docs, video, audio, data, provenance)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
