#!/usr/bin/env python3
"""Studio Bridge — JSON-RPC 2.0 over newline-delimited stdio.

VendoTube Studio (Electron main process) spawns this process and speaks
newline-delimited JSON-RPC on stdin/stdout. The DWK toolkit prints freely to
stdout, so the ORIGINAL stdout is reserved for protocol frames and everything
else (including library prints) is demoted to stderr before imports.

M1 method groups: sys.*, dwk.* (discover/extract/download), ledger.*,
assets.*, extract.article, fetch.metadata, media.thumbnail, ytdlp.download.
M3 groups: tts.* (edge-tts voices/generate/preview with word boundaries,
WAV 48 kHz, content-hash cache, SAPI offline fallback), dwk.validate_srt.
"""
from __future__ import annotations

import base64
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

BRIDGE_DIR = Path(__file__).resolve().parent

# --- protocol channel: keep the real stdout for frames, demote the rest ----
# Windows pipes default to the locale codec (cp1252/charmap); research content
# is Unicode, so every stream is forced to UTF-8 and protocol frames are also
# written ASCII-safe (ensure_ascii) as belt-and-braces.
PROTO = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
PROTO_LOCK = threading.Lock()  # serializes response frames written from worker threads
sys.stdout = sys.stderr  # DWK's print() and subprocess chatter go to stderr
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass  # best effort; PROTO is already UTF-8 and frames are ASCII-safe

from guard import assert_public_http_url  # noqa: E402
import qc_scan  # noqa: E402  (visual QC Layer 0 — M7)


def _resolve_dwk_root() -> Path:
    env = os.environ.get("DWK_PATH")
    if env:
        return Path(env).resolve()
    # dev layout: vendotube-studio/bridge -> VendoTube/ -> DWK package
    return (BRIDGE_DIR / ".." / ".." / "documentary_workflow_kit" / "documentary_workflow_kit").resolve()


DWK_ROOT = _resolve_dwk_root()
sys.path.insert(0, str(DWK_ROOT))

DWK_LOAD_ERROR: str | None = None
try:
    import dwk_ledger as ledger  # noqa: E402  (imports workflow.* itself)

    from workflow.common import ffmpeg_path, ffprobe_path, sha256  # noqa: E402
    from workflow.discover_media import archive as dm_archive  # noqa: E402
    from workflow.discover_media import commons as dm_commons  # noqa: E402
    from workflow.discover_media import loc as dm_loc  # noqa: E402
    from workflow.discover_sources import crossref as ds_crossref  # noqa: E402
    from workflow.discover_sources import wikipedia as ds_wikipedia  # noqa: E402
    from workflow.extract_articles import extract as dwe_extract  # noqa: E402
    from workflow.extract_articles import robots_allows  # noqa: E402
    from workflow.init_project import init_project as dwk_init_project  # noqa: E402
    from workflow.validate_project import validate as dwk_validate  # noqa: E402
    from workflow.validate_srt import validate as dwk_validate_srt  # noqa: E402
    from workflow.finalize import finalize as dwk_finalize  # noqa: E402
    from workflow.qc import inspect as dwk_qc_inspect  # noqa: E402
    from workflow.package_project import package as dwk_package  # noqa: E402
    from workflow.render_video import render as dwk_render_video  # noqa: E402
except Exception as exc:  # deps missing / DWK moved — keep bridge alive to report
    DWK_LOAD_ERROR = f"{type(exc).__name__}: {exc}"
    ledger = None  # type: ignore[assignment]

# edge-tts is optional at import time so the bridge stays alive to report;
# generate() falls back to SAPI when it is missing or the endpoint refuses.
_EDGE_LOAD_ERROR: str | None = None
try:
    import edge_tts  # type: ignore[import-not-found]  # noqa: E402
except Exception as exc:  # pragma: no cover
    _EDGE_LOAD_ERROR = f"{type(exc).__name__}: {exc}"

VERSION = "0.2.0"

METHODS: dict[str, callable] = {}


def method(name: str):
    def register(fn):
        METHODS[name] = fn
        return fn

    return register


def _require_dwk():
    if DWK_LOAD_ERROR is not None:
        raise RuntimeError(f"DWK toolkit not loaded ({DWK_LOAD_ERROR}). Check DWK_PATH and the venv deps.")


def _as_path(value: str) -> Path:
    return Path(str(value)).expanduser()


def _project(params: dict) -> Path:
    p = _as_path(params["project_path"]).resolve()
    if not (p / "project.yml").exists():
        raise ValueError(f"not a documentary project: {p}")
    return p


def _project_rel(project: Path, value: str | Path) -> Path:
    """Resolve a (possibly project-relative) path parameter against the project —
    the bridge process CWD must never leak into artifact locations."""
    p = _as_path(value)
    return p if p.is_absolute() else project / p


# --------------------------------------------------------------------- sys

@method("sys.ping")
def sys_ping(params: dict) -> dict:
    return {
        "ok": True,
        "version": VERSION,
        "python": sys.version.split()[0],
        "dwk_root": str(DWK_ROOT),
        "dwk_loaded": DWK_LOAD_ERROR is None,
        "dwk_error": DWK_LOAD_ERROR,
        "ytdlp": shutil.which("yt-dlp"),
    }


@method("sys.paths")
def sys_paths(params: dict) -> dict:
    _require_dwk()
    ffmpeg = None
    try:
        ffmpeg = ffmpeg_path()
    except Exception as exc:
        ffmpeg = f"unavailable: {exc}"
    return {
        "python": sys.executable,
        "dwk_root": str(DWK_ROOT),
        "ffmpeg": ffmpeg,
        "ffprobe": ffprobe_path(),
    }


@method("sys.cancel")
def sys_cancel(params: dict) -> dict:
    # M1: jobs are cancelled by killing/restarting work in the main process;
    # long-running bridge operations gain cooperative cancel in M2+.
    return {"cancelled": params.get("job_id"), "acknowledged": True}


# --------------------------------------------------------------------- dwk

@method("dwk.init_project")
def dwk_init(params: dict) -> dict:
    _require_dwk()
    path = _as_path(params["path"])
    title = str(params.get("title") or "Untitled Documentary")
    fps = int(params.get("fps") or 60)
    # runtime=None (absent) → project.yml omits target_runtime_seconds: the
    # studio Director decides the film length from the research (auto mode).
    raw_runtime = params.get("runtime")
    runtime = int(raw_runtime) if raw_runtime is not None else None
    language = str(params.get("language") or "en")
    if fps not in (24, 25, 30, 50, 60):
        raise ValueError("fps must be one of 24, 25, 30, 50, 60")
    result = dwk_init_project(path, title, fps, runtime, language)
    return {"project_path": str(result)}


@method("dwk.validate_project")
def dwk_validate_method(params: dict) -> dict:
    _require_dwk()
    report = dwk_validate(_project(params))
    return report


@method("dwk.discover_sources")
def dwk_discover_sources(params: dict) -> dict:
    _require_dwk()
    provider = str(params.get("provider") or "crossref")
    query = str(params.get("query") or "").strip()
    if not query:
        raise ValueError("query is required")
    limit = int(params.get("limit") or 10)
    rows = (ds_crossref if provider == "crossref" else ds_wikipedia)(query, limit)
    return {"provider": provider, "count": len(rows), "rows": rows}


@method("dwk.discover_media")
def dwk_discover_media(params: dict) -> dict:
    _require_dwk()
    provider = str(params.get("provider") or "commons")
    query = str(params.get("query") or "").strip()
    if not query:
        raise ValueError("query is required")
    limit = int(params.get("limit") or 12)
    fn = {"commons": dm_commons, "loc": dm_loc, "archive": dm_archive}.get(provider)
    if fn is None:
        raise ValueError("provider must be commons|loc|archive")
    rows = fn(query, limit)
    return {"provider": provider, "count": len(rows), "rows": _postprocess_discover_rows(query, rows)}


# Commons full-text search matches scanned-book PDFs (DjVu/PDF of entire books
# can contain every query word), so "history of X" queries surface irrelevant
# scans mislabeled as images. DWK stays untouched — the Bridge post-processes
# its rows: derive the honest media_type from the file extension and rank rows
# by title/query word overlap so topic-matching assets surface first.
_MEDIA_EXT_TYPE = {
    ".jpg": "image", ".jpeg": "image", ".png": "image", ".gif": "image",
    ".webp": "image", ".svg": "image", ".tif": "image", ".tiff": "image",
    ".pdf": "document", ".djvu": "document", ".djv": "document", ".epub": "document",
    ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".oga": "audio",
    ".flac": "audio", ".m4a": "audio", ".aac": "audio",
    ".mp4": "video", ".webm": "video", ".ogv": "video", ".mov": "video", ".mkv": "video",
}

_QUERY_STOPWORDS = {"the", "and", "for", "with", "from", "that", "this", "of", "in", "on", "at", "by", "a", "an"}


def _row_media_type(url: str) -> str | None:
    try:
        path = urlsplit(url).path.lower()
        return _MEDIA_EXT_TYPE.get(Path(path).suffix)
    except Exception:
        return None


def _relevance_score(query: str, title: str) -> int:
    words = [w for w in re.split(r"\s+", query.lower()) if len(w) >= 3 and w not in _QUERY_STOPWORDS]
    title_l = title.lower()
    return sum(1 for w in words if re.search(rf"\b{re.escape(w)}", title_l))


def _postprocess_discover_rows(query: str, rows: list[dict]) -> list[dict]:
    for row in rows:
        derived = _row_media_type(str(row.get("download_url") or ""))
        if derived:
            row["media_type"] = derived
    scored = [( _relevance_score(query, str(row.get("title") or "")), i, row) for i, row in enumerate(rows)]
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [row for _, _, row in scored]


@method("dwk.download_assets")
def dwk_download_assets(params: dict) -> dict:
    """Rights-gated downloader — runs the DWK CLI module via subprocess so the
    enforcement path is byte-identical to the CLI (AGENT_GUIDE discipline)."""
    _require_dwk()
    project = _project(params)
    manifest = _as_path(params.get("manifest") or (project / "research" / "assets_to_download.csv"))
    ledger_path = project / "research" / "downloaded_assets.csv"
    before = 0
    if ledger_path.exists():
        with ledger_path.open(encoding="utf-8-sig", newline="") as f:
            before = sum(1 for _ in csv.DictReader(f))
    proc = subprocess.run(
        [sys.executable, "-m", "workflow.download_assets", "--manifest", str(manifest), "--project", str(project)],
        cwd=str(DWK_ROOT),
        capture_output=True,
        text=True,
        timeout=900,
    )
    after_rows: list[dict] = []
    if ledger_path.exists():
        with ledger_path.open(encoding="utf-8-sig", newline="") as f:
            after_rows = [dict(r) for r in csv.DictReader(f)]
    added = after_rows[before:]
    return {
        "exit_code": proc.returncode,
        "output": (proc.stdout or "")[-4000:],
        "errors": (proc.stderr or "")[-2000:],
        "added_count": len(added),
        "added": added,
    }


# ----------------------------------------------------------------- ledger

@method("ledger.append_sources")
def ledger_append_sources(params: dict) -> dict:
    _require_dwk()
    rows = params.get("rows") or []
    res = ledger.append_sources(_project(params), rows)
    return {"count": len(res["saved"]), "skipped": res["skipped"], "rows": res["saved"]}


@method("ledger.append_claims")
def ledger_append_claims(params: dict) -> dict:
    _require_dwk()
    rows = params.get("rows") or []
    res = ledger.append_claims(_project(params), rows)
    return {"count": len(res["saved"]), "skipped": res["skipped"], "rows": res["saved"]}


@method("ledger.append_assets")
def ledger_append_assets(params: dict) -> dict:
    _require_dwk()
    rows = params.get("rows") or []
    res = ledger.append_asset_candidates(_project(params), rows)
    return {"count": len(res["saved"]), "skipped": res["skipped"], "rows": res["saved"]}


@method("ledger.digest")
def ledger_digest(params: dict) -> dict:
    """Compact view of what is already registered — Scout's anti-duplicate context."""
    _require_dwk()
    project = _project(params)
    sources = ledger.read_rows(project, "research/sources.csv")
    claims = ledger.read_rows(project, "research/evidence_ledger.csv")
    assets = ledger.read_rows(project, "research/assets_to_download.csv")
    return {
        "source_urls": [(r.get("url") or "").strip() for r in sources if r.get("url")],
        "source_ids": [(r.get("source_id") or "", (r.get("title") or "")[:60]) for r in sources],
        "claims": [
            {"claim_id": r.get("claim_id"), "text": (r.get("claim_text") or "")[:120], "source_id": r.get("source_id")}
            for r in claims
        ][:40],
        "counts": {"sources": len(sources), "claims": len(claims), "asset_candidates": len(assets)},
    }


@method("dwk.write_shot_list")
def dwk_write_shot_list(params: dict) -> dict:
    _require_dwk()
    rows = params.get("rows") or []
    return ledger.write_shot_list(_project(params), rows)


@method("ledger.set_rights")
def ledger_set_rights(params: dict) -> dict:
    changed = ledger.set_rights_status(
        _project(params),
        list(params.get("asset_ids") or []),
        str(params.get("rights_status") or ""),
        params.get("notes"),
    )
    return {"changed": changed}


@method("ledger.list")
def ledger_list(params: dict) -> dict:
    kind = str(params.get("kind") or "")
    rel = {
        "sources": "research/sources.csv",
        "evidence": "research/evidence_ledger.csv",
        "assets": "research/assets_to_download.csv",
        "downloaded": "research/downloaded_assets.csv",
    }.get(kind)
    if rel is None:
        raise ValueError("kind must be sources|evidence|assets|downloaded")
    return {"kind": kind, "rows": ledger.read_rows(_project(params), rel)}


# ----------------------------------------------------------------- assets

@method("assets.list")
def assets_list(params: dict) -> dict:
    _require_dwk()
    return ledger.list_assets(_project(params))


@method("media.thumbnail")
def media_thumbnail(params: dict) -> dict:
    _require_dwk()
    project = _project(params)
    media = _as_path(params["media_path"])
    if not media.exists():
        raise ValueError(f"media not found: {media}")
    thumbs = project / "studio" / "thumbs"
    thumbs.mkdir(parents=True, exist_ok=True)
    out = thumbs / (re.sub(r"[^A-Za-z0-9._-]+", "_", media.stem)[:60] + ".jpg")
    if not out.exists():
        # Handlers run concurrently now: build into a unique temp name and
        # rename, so two thumbnails of one file cannot interleave a half JPEG.
        tmp = out.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp.jpg")
        if media.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"):
            subprocess.run(
                [ffmpeg_path(), "-y", "-i", str(media), "-vf", "scale=320:-2", str(tmp)],
                capture_output=True,
                timeout=60,
            )
        else:
            # Fast seek BEFORE -i (input seeking) and stop at the first frame:
            # decoding from 0 on a multi-hundred-MB clip held the old serial
            # bridge long enough to time out every request behind it.
            subprocess.run(
                [ffmpeg_path(), "-y", "-ss", "1", "-i", str(media), "-frames:v", "1", "-an",
                 "-vf", "scale=320:-2", str(tmp)],
                capture_output=True,
                timeout=90,
            )
        if tmp.exists() and tmp.stat().st_size > 0:
            tmp.replace(out)
        else:
            tmp.unlink(missing_ok=True)
    if not out.exists():
        return {"thumb": None}
    return {"thumb": str(out.relative_to(project))}


@method("media.concat_audio")
def media_concat_audio(params: dict) -> dict:
    """Concatenate per-section narration WAVs into one gapless track (48 kHz
    stereo PCM — SAPI fallback files arrive mono and are re-laid-out here so
    dwk.finalize's amix sees uniform inputs). Order = scene order = timeline."""
    _require_dwk()
    project = _project(params)
    wavs: list[Path] = []
    for w in params.get("wavs") or []:
        p = _as_path(w)
        if not p.is_absolute():
            p = project / p  # project-relative paths (pipeline artifacts) resolve against the project
        wavs.append(p)
    if not wavs:
        raise ValueError("wavs list is empty")
    for w in wavs:
        if not w.is_file():
            raise ValueError(f"narration file missing: {w}")
    out = _as_path(params.get("out") or (project / "production" / "vo" / "narration_full.wav"))
    if not out.is_absolute():
        out = project / out
    out.parent.mkdir(parents=True, exist_ok=True)
    listfile = out.with_suffix(".concat.txt")
    listfile.write_text("".join(f"file '{str(w.resolve()).replace(chr(39), chr(39) + chr(39))}'\n" for w in wavs), encoding="utf-8")
    proc = subprocess.run(
        [ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
         "-i", str(listfile), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(out)],
        capture_output=True, text=True, timeout=600,
    )
    listfile.unlink(missing_ok=True)
    if proc.returncode != 0 or not out.is_file():
        raise RuntimeError(f"narration concat failed: {(proc.stderr or '')[-300:]}")
    return {
        "wav": str(out.relative_to(project)),
        "duration_s": round(_audio_duration_s(out), 3),
        "bytes": out.stat().st_size,
        "sections": len(wavs),
    }


@method("media.concat_video")
def media_concat_video(params: dict) -> dict:
    """Concatenate per-scene render segments into the picture master.
    Tries stream-copy concat first (hyperframes segments share encoder
    settings); falls back to a re-encode concat if timebases disagree."""
    _require_dwk()
    project = _project(params)
    vids: list[Path] = []
    for v in params.get("videos") or []:
        p = _project_rel(project, v)
        if not p.is_file():
            raise ValueError(f"segment missing: {v}")
        vids.append(p)
    if not vids:
        raise ValueError("videos list is empty")
    out = _project_rel(project, params.get("out") or (project / "delivery" / "picture.mp4"))
    out.parent.mkdir(parents=True, exist_ok=True)

    def probe_duration(path: Path) -> float:
        try:
            proc = subprocess.run(
                [ffprobe_path(), "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
                capture_output=True, text=True, timeout=60,
            )
            return float(json.loads(proc.stdout or "{}").get("format", {}).get("duration") or 0.0)
        except Exception:
            return 0.0

    expected = sum(probe_duration(v) for v in vids)

    listfile = out.with_suffix(".concat.txt")
    listfile.write_text("".join(f"file '{str(v.resolve()).replace(chr(39), chr(39) + chr(39))}'\n" for v in vids), encoding="utf-8")
    tmp = out.with_suffix(".concat.mp4")
    mode = "copy"
    proc = subprocess.run(
        [ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
         "-i", str(listfile), "-c", "copy", "-movflags", "+faststart", str(tmp)],
        capture_output=True, text=True, timeout=1800,
    )
    got = probe_duration(tmp) if tmp.is_file() else 0.0
    if proc.returncode != 0 or not tmp.is_file() or abs(got - expected) > 0.35:
        mode = "reencode"
        proc = subprocess.run(
            [ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
             "-i", str(listfile), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(tmp)],
            capture_output=True, text=True, timeout=3600,
        )
        got = probe_duration(tmp) if tmp.is_file() else 0.0
    listfile.unlink(missing_ok=True)
    if proc.returncode != 0 or not tmp.is_file():
        raise RuntimeError(f"segment concat failed: {(proc.stderr or '')[-300:]}")
    if expected > 0 and abs(got - expected) > 0.35:
        raise RuntimeError(f"concat duration drift: expected {expected:.3f}s, got {got:.3f}s")
    tmp.replace(out)
    return {"out": str(out.relative_to(project)), "duration_s": round(got, 3), "segments": len(vids), "mode": mode}


@method("media.place_sfx")
def media_place_sfx(params: dict) -> dict:
    """Overlay SFX on the gapless narration track (M4 beat-synced sound design).
    DWK finalize takes a single narration input, so Studio pre-mixes: each
    placement is adelay'd to its picture-clock moment and amix'd (no normalize)
    over the narration. Missing SFX files are reported, never fatal."""
    _require_dwk()
    project = _project(params)
    narration = _project_rel(project, params["narration"])
    if not narration.is_file():
        raise ValueError(f"narration not found: {params['narration']}")
    placements = params.get("placements") or []
    resolved: list[tuple[Path, float, float]] = []
    skipped: list[str] = []
    for pl in placements:
        p = _project_rel(project, str(pl.get("path") or ""))
        if not p.is_file():
            skipped.append(str(pl.get("path")))
            continue
        try:
            at_s = max(0.0, float(pl.get("at_s") or 0))
        except (TypeError, ValueError):
            at_s = 0.0
        try:
            gain_db = float(pl.get("gain_db") if pl.get("gain_db") is not None else -6.0)
        except (TypeError, ValueError):
            gain_db = -6.0
        resolved.append((p, at_s, gain_db))
    out = _project_rel(project, params.get("out") or (project / "production" / "vo" / "narration_sfx.wav"))
    out.parent.mkdir(parents=True, exist_ok=True)
    if not resolved:
        shutil.copyfile(narration, out)
        return {"out": str(out.relative_to(project)), "placed": 0, "skipped": skipped, "mixed": False}

    import math

    inputs = [str(narration.resolve())]
    chains: list[str] = []
    labels: list[str] = []
    for i, (p, at_s, gain_db) in enumerate(resolved, start=1):
        inputs.append(str(p.resolve()))
        delay_ms = int(math.floor(at_s * 1000))
        chains.append(
            f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={delay_ms}:all=1,volume={gain_db:.2f}dB[s{i}]"
        )
        labels.append(f"[s{i}]")
    graph = ";".join(chains) + ";" + f"[0:a]{''.join(labels)}amix=inputs={len(resolved) + 1}:duration=first:normalize=0,alimiter=limit=0.98:level=0[aout]"
    proc = subprocess.run(
        [ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-y", *sum([["-i", inp] for inp in inputs], []),
         "-filter_complex", graph, "-map", "[aout]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(out)],
        capture_output=True, text=True, timeout=1800,
    )
    if proc.returncode != 0 or not out.is_file():
        raise RuntimeError(f"sfx mix failed: {(proc.stderr or '')[-300:]}")
    return {
        "out": str(out.relative_to(project)),
        "placed": len(resolved),
        "skipped": skipped,
        "duration_s": round(_audio_duration_s(out), 3),
        "mixed": True,
    }


@method("media.loudness")
def media_loudness(params: dict) -> dict:
    """Integrated LUFS via ffmpeg ebur128 (retention_report + QC context)."""
    _require_dwk()
    project = _project(params)
    media = _project_rel(project, params["media_path"]).resolve()
    if not media.is_file():
        raise ValueError(f"media not found: {media}")
    proc = subprocess.run(
        [ffmpeg_path(), "-hide_banner", "-nostats", "-i", str(media), "-filter_complex", "ebur128", "-f", "null", "-"],
        capture_output=True, text=True, timeout=1800,
    )
    m = re.findall(r"I:\s*(-?[\d.]+)\s*LUFS", proc.stderr or "")
    integrated = float(m[-1]) if m else None
    return {"integrated_lufs": integrated, "ok": integrated is not None}


@method("media.loudnorm_conform")
def media_loudnorm_conform(params: dict) -> dict:
    """Two-pass loudnorm conform of the muxed master's audio to the project
    LUFS target (M4 exit: −14 ± 1). Video stream is copied untouched; audio is
    re-encoded (aac 192k). Pass 1 measures (loudnorm print_format=json),
    pass 2 applies with measured_* (linear when the limiter allows). The file
    is replaced only when the conform actually improves |deviation|."""
    _require_dwk()
    project = _project(params)
    src = _project_rel(project, params["media_path"]).resolve()
    if not src.is_file():
        raise ValueError(f"media not found: {src}")
    try:
        target = float(params.get("target_lufs") or -14.0)
    except (TypeError, ValueError):
        target = -14.0
    tp = -1.5
    lra = 11.0
    before = media_loudness({"project_path": str(project), "media_path": str(src)})["integrated_lufs"]
    if before is None:
        raise RuntimeError("could not measure source loudness (ebur128)")
    if abs(before - target) <= 1.0:
        return {"conformed": False, "lufs_before": before, "lufs_after": before, "reason": "already within ±1 LU"}

    import tempfile

    analysis: dict = {}
    with tempfile.TemporaryDirectory(prefix="loudnorm-") as td:
        pass1 = subprocess.run(
            [ffmpeg_path(), "-hide_banner", "-nostats", "-i", str(src),
             "-af", f"loudnorm=I={target:g}:TP={tp:g}:LRA={lra:g}:print_format=json",
             "-f", "null", "-"],
            capture_output=True, text=True, timeout=3600,
        )
        m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", pass1.stderr or "", re.S)
        if m:
            try:
                analysis = json.loads(m.group(0))
            except json.JSONDecodeError:
                analysis = {}
        if not analysis.get("input_i"):
            raise RuntimeError(f"loudnorm analysis failed: {(pass1.stderr or '')[-300:]}")

        out_tmp = Path(td) / "conformed.mp4"
        af = (
            f"loudnorm=I={target:g}:TP={tp:g}:LRA={lra:g}"
            f":measured_I={float(analysis['input_i']):g}"
            f":measured_TP={float(analysis['input_tp']):g}"
            f":measured_LRA={float(analysis['input_lra']):g}"
            f":measured_thresh={float(analysis['input_thresh']):g}"
            f":offset={float(analysis.get('target_offset', 0) or 0):g}"
            ":linear=true:print_format=summary"
        )
        proc = subprocess.run(
            [ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
             "-map", "0", "-af", af, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
             # Pin 48 kHz: loudnorm internally resamples (up to 192 kHz) and the
             # AAC encoder would otherwise inherit that rate, yielding a 96 kHz
             # track that Chromium's <video> renders as silence in the preview.
             "-ar", "48000", "-ac", "2", "-c:s", "copy", str(out_tmp)],
            capture_output=True, text=True, timeout=3600,
        )
        if proc.returncode != 0 or not out_tmp.is_file():
            raise RuntimeError(f"loudnorm conform failed: {(proc.stderr or '')[-300:]}")
        after = media_loudness({"project_path": str(project), "media_path": str(out_tmp)})["integrated_lufs"]
        if after is None:
            raise RuntimeError("could not measure conformed loudness")
        if abs(after - target) < abs(before - target):
            shutil.copyfile(out_tmp, src)
            return {"conformed": True, "lufs_before": before, "lufs_after": after}
        return {
            "conformed": False,
            "lufs_before": before,
            "lufs_after": after,
            "reason": "conform did not improve loudness — kept original (disclosed)",
        }


# ---------------------------------------------------------- visual QC (M7)

@method("qc.scan_master")
def qc_scan_master(params: dict) -> dict:
    """Visual QC Layer 0 (M7): deterministic ffmpeg detectors on the rendered
    master — blackdetect/freezedetect/silencedetect + scene-cut timestamps.
    RAW ranges only; the Node pipeline classifies findings and severities
    (DATA-SCHEMA §7.1). Fully local, no AI (PRD R11)."""
    _require_dwk()
    project = _project(params)
    media = _project_rel(project, params["media_path"]).resolve()
    if not media.is_file():
        raise ValueError(f"media not found: {media}")

    def _num(key: str, default: float) -> float:
        try:
            return float(params.get(key) if params.get(key) is not None else default)
        except (TypeError, ValueError):
            return default

    return qc_scan.scan_master(
        media,
        black_min_s=_num("black_min_s", 0.5),
        freeze_min_s=_num("freeze_min_s", 2.0),
        silence_min_s=_num("silence_min_s", 1.0),
        scene_thresh=_num("scene_thresh", 0.2),
    )


@method("qc.sample_frames")
def qc_sample_frames(params: dict) -> dict:
    """Sample JPEG stills of the master into the regenerable cache
    qc/visual_frames/<sha8>/ (DATA-SCHEMA §7.2). The sampling plan (times,
    budget) is the caller's; the bridge enforces the 600-frame ceiling."""
    _require_dwk()
    project = _project(params)
    media = _project_rel(project, params["media_path"]).resolve()
    if not media.is_file():
        raise ValueError(f"media not found: {media}")
    times = [float(t) for t in (params.get("times") or [])]
    sha8 = str(params.get("sha8") or "")
    if not times or not re.fullmatch(r"[0-9a-f]{8}", sha8):
        raise ValueError("times (non-empty) and sha8 (8 hex chars) are required")
    width = int(params.get("width") or 768)
    return qc_scan.sample_frames(media, times, sha8, project.resolve(), width=width)


@method("media.frames_at")
def media_frames_at(params: dict) -> dict:
    """Sample a SOURCE clip (a downloaded research video) at candidate
    in-points into studio/video_frames/<tag>/.

    The video-moment picker reads these stills to choose which seconds of a
    clip illustrate a scene. Returns each frame's timestamp plus the clip
    duration, so the caller can clamp a chosen in-point without a second
    probe. `tag` (clip id + shot index) namespaces the cache."""
    _require_dwk()
    project = _project(params)
    media = _project_rel(project, params["media_path"]).resolve()
    if not media.is_file():
        raise ValueError(f"media not found: {media}")
    times = [float(t) for t in (params.get("times") or [])]
    tag = re.sub(r"[^A-Za-z0-9._-]+", "_", str(params.get("tag") or "")).strip("._-")[:80]
    if not times or not tag:
        raise ValueError("times (non-empty) and tag are required")
    width = int(params.get("width") or 512)
    return qc_scan.source_frames(media, times, tag, project.resolve(), width=width)


# --------------------------------------------------------------- extraction

@method("extract.article")
def extract_article(params: dict) -> dict:
    """Robots-aware single-URL extraction (DWK robots_allows + trafilatura)."""
    _require_dwk()
    project = _project(params)
    url = str(params.get("url") or "").strip()
    if not url:
        raise ValueError("url is required")
    assert_public_http_url(url)
    if not robots_allows(url):
        return {"ok": False, "reason": "robots-disallowed", "url": url}
    import io

    from guard import guarded_request

    from workflow.extract_articles import UA

    with guarded_request("GET", url, headers={"User-Agent": UA}, stream=True, timeout=(15, 75)) as r:
        r.raise_for_status()
        chunks: list[bytes] = []
        size = 0
        for chunk in r.iter_content(65536):
            size += len(chunk)
            if size > 30_000_000:
                raise ValueError("response exceeds 30MB limit (PDFs and datasets are often larger)")
            chunks.append(chunk)
        raw = b"".join(chunks)
        content_type = r.headers.get("content-type", "").lower()
        final_url = r.url
    if "application/pdf" in content_type or raw[:5] == b"%PDF-":
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(raw))
        text = "\n\n".join(page.extract_text() or "" for page in reader.pages)
        kind = "pdf"
    else:
        body = raw.decode("utf-8", errors="replace")
        text = dwe_extract(body, final_url)
        kind = "web"
    if not text or not text.strip():
        return {"ok": False, "reason": "no-text", "url": url}
    sid = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(params.get("source_id") or "source")).strip("._") or "source"
    out_dir = project / "research" / "article_text"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{sid}.txt"
    header = f"SOURCE_ID: {sid}\nTITLE: {params.get('title') or ''}\nURL: {url}\n\n"
    out.write_text(header + text + "\n", encoding="utf-8")
    return {"ok": True, "kind": kind, "chars": len(text), "path": str(out.relative_to(project)), "url": url,
            "preview": text[:1200]}


@method("extract.data")
def extract_data(params: dict) -> dict:
    """Sniff a downloaded CSV/JSON file into a preview for the ledger.
    Content-sniffs JSON regardless of file extension (downloads often lose it)."""
    path = _as_path(params["path"])
    if not path.exists():
        raise ValueError(f"file not found: {path}")
    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    stripped = raw.lstrip()
    if stripped[:1] in ("{", "["):
        try:
            data = json.loads(stripped)
            if isinstance(data, list):
                keys = list(data[0].keys()) if data and isinstance(data[0], dict) else []
                return {"kind": "json", "rows": len(data), "columns": keys, "preview": data[:5]}
            if isinstance(data, dict):
                return {"kind": "json", "rows": 1, "columns": list(data.keys())[:50], "preview": data}
        except json.JSONDecodeError:
            pass  # fell through to CSV sniffing
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        rows = list(reader)
    if len(rows) < 1:
        return {"kind": "csv", "rows": 0, "columns": [], "preview": []}
    return {"kind": "csv", "rows": max(0, len(rows) - 1), "columns": rows[0], "preview": rows[1:6]}


# ------------------------------------------------------------------- fetch

@method("fetch.metadata")
def fetch_metadata(params: dict) -> dict:
    from guard import guarded_request

    url = str(params.get("url") or "").strip()
    r = guarded_request("HEAD", url, timeout=20)
    return {
        "status": r.status_code,
        "content_type": r.headers.get("content-type", ""),
        "length": int(r.headers.get("content-length", 0) or 0),
        "final_url": r.url,
    }


# ------------------------------------------------------------------- yt-dlp

def _is_direct_media_url(url: str, kinds: set[str]) -> bool:
    """True when the URL path itself ends in a media extension — i.e. the file
    can be fetched directly rather than extracted by yt-dlp."""
    try:
        return Path(urlsplit(url).path.lower()).suffix.lstrip(".") in kinds
    except Exception:
        return False


_DIRECT_AUDIO_EXTS = {"mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus"}
_DIRECT_VIDEO_EXTS = {"mp4", "webm", "ogv", "mov", "mkv", "avi"}

_KNOWN_FILE_EXTS = _DIRECT_AUDIO_EXTS | _DIRECT_VIDEO_EXTS | {
    "jpg", "jpeg", "png", "gif", "webp", "svg", "tif", "tiff", "bin",
    "csv", "tsv", "pdf", "txt", "json", "zip", "md", "xml", "srt",
}


def _ytdlp_fetch_file(project: Path, url: str, audio: bool = False, timeout_s: int = 3600) -> Path | None:
    exe = shutil.which("yt-dlp")
    if not exe:
        raise RuntimeError("yt-dlp is not installed or not on PATH")
    folder = project / "media" / ("audio" if audio else "video")
    folder.mkdir(parents=True, exist_ok=True)
    before = {p.name for p in folder.glob("*") if p.is_file()}
    fmt = ["-x", "--audio-format", "mp3", "--audio-quality", "192K"] if audio else [
        "-f", "bv*[height<=1080]+ba/b", "--merge-output-format", "mp4"
    ]
    proc = subprocess.run(
        [exe, *fmt, "--no-playlist", "--no-progress", "-o", str(folder / "%(title).80s.%(ext)s"), "--", url],
        capture_output=True, text=True, timeout=timeout_s,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {(proc.stderr or proc.stdout or '')[-220:]}")
    after = [p for p in folder.glob("*") if p.is_file() and p.name not in before]
    return after[0] if after else None


def _fetch_media_file(project: Path, url: str, subfolder: str, max_bytes: int) -> Path:
    from guard import guarded_request

    dest_dir = project / "media" / subfolder
    dest_dir.mkdir(parents=True, exist_ok=True)
    with guarded_request("GET", url, stream=True, timeout=(15, 75)) as r:
        r.raise_for_status()
        ct = r.headers.get("content-type", "").lower()
        if ct.startswith("text/html"):
            raise ValueError("got an HTML page, not a media file")
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", url.split("/")[-1].split("?")[0])[:80] or "asset"
        # The URL's trailing dot is not always an extension ("1706.03762" is a
        # version number) — only trust suffixes that are known media types.
        if Path(name).suffix.lower().lstrip(".") not in _KNOWN_FILE_EXTS:
            ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
                   "image/svg+xml": ".svg", "application/json": ".json", "application/pdf": ".pdf",
                   "application/zip": ".zip", "text/plain": ".txt", "text/csv": ".csv",
                   "text/markdown": ".md", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
                   "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/ogg": ".ogg",
                   "audio/flac": ".flac", "audio/aac": ".aac", "video/mp4": ".mp4",
                   "video/webm": ".webm"}.get(ct.split(";")[0], ".bin")
            name += ext
        dest = dest_dir / name
        tmp = dest.with_suffix(dest.suffix + ".part")
        size = 0
        with tmp.open("wb") as f:
            for chunk in r.iter_content(1024 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError(f"exceeds size limit ({max_bytes} bytes)")
                f.write(chunk)
        tmp.replace(dest)
        return dest


def _download_asset_row(project: Path, row: dict, ytdlp_timeout_s: int = 3600) -> Path:
    """Route one asset row to its download channel by media type: audio/video
    via yt-dlp (with direct-file fallbacks), everything else via the guarded
    direct downloader into media/web/. The yt-dlp timeout bounds how long ONE
    stalled download can hold the single-threaded bridge (2026-11-15: a
    research-time video fetch stalled the Director's digest for ~8 min) —
    research-time fetches pass a short bound; user-gated downloads keep the
    full hour."""
    url = (row.get("download_url") or "").strip()
    media_type = (row.get("media_type") or "").lower()
    assert_public_http_url(url)
    if media_type == "audio":
        try:
            saved = _ytdlp_fetch_file(project, url, audio=True, timeout_s=ytdlp_timeout_s)
        except Exception:
            # Direct audio files (mp3/wav/ogg) don't always survive yt-dlp's
            # generic extractor + postprocessing — fall back to a guarded
            # direct download into media/audio/.
            if _is_direct_media_url(url, _DIRECT_AUDIO_EXTS):
                saved = _fetch_media_file(project, url, subfolder="audio", max_bytes=200_000_000)
            else:
                raise
    elif media_type == "video" or "youtu" in url.lower():
        try:
            saved = _ytdlp_fetch_file(project, url, timeout_s=ytdlp_timeout_s)
        except Exception:
            # Same idea for direct video files (e.g. archive.org mp4s): fetch
            # the file directly instead of failing the row.
            if _is_direct_media_url(url, _DIRECT_VIDEO_EXTS):
                saved = _fetch_media_file(project, url, subfolder="video", max_bytes=200_000_000)
            else:
                raise
    else:
        saved = _fetch_media_file(project, url, subfolder="web", max_bytes=200_000_000)
    if saved is None:
        raise ValueError("download produced no file")
    return saved


@method("web.download_assets")
def web_download_assets(params: dict) -> dict:
    """App-side downloader for UNVERIFIED web media the user explicitly approved
    (gate G-C with a rights warning). Separate from DWK's license gate: images
    go to media/web/, videos via yt-dlp to media/video/, provenance recorded in
    downloaded_assets.csv with the 'unverified' license label."""
    _require_dwk()
    project = _project(params)
    want = {a.strip() for a in (params.get("asset_ids") or [])}
    rows = ledger.read_rows(project, "research/assets_to_download.csv")
    results: list[dict] = []
    downloaded = 0
    failed = 0
    for row in rows:
        aid = (row.get("asset_id") or "").strip()
        if aid not in want:
            continue
        if (row.get("rights_status") or "").strip().lower() != "approved":
            results.append({**row, "error": "not approved"}); failed += 1; continue
        try:
            saved = _download_asset_row(project, row)
            results.append({
                **row,
                "saved_path": str(saved.relative_to(project)),
                "sha256": sha256(saved),
                "bytes": saved.stat().st_size,
            })
            downloaded += 1
        except Exception as exc:
            results.append({**row, "error": f"{type(exc).__name__}: {exc}"})
            failed += 1
    saved_rows = [r for r in results if "saved_path" in r]
    if saved_rows:
        ledger.record_downloads(project, saved_rows)
    return {"downloaded": downloaded, "failed": failed, "rows": results}


@method("web.research_fetch")
def web_research_fetch(params: dict) -> dict:
    """Research-time fetch: download the candidates the Scout run just proposed
    WITHOUT flipping the rights gate — rights_status stays 'review' and the
    provenance rows are marked for editorial review. Film assembly still uses
    the user-gated flow (G-C approval + web.download_assets / DWK channel)."""
    _require_dwk()
    project = _project(params)
    want = {a.strip() for a in (params.get("asset_ids") or [])}
    rows = ledger.read_rows(project, "research/assets_to_download.csv")
    results: list[dict] = []
    downloaded = 0
    failed = 0
    for row in rows:
        aid = (row.get("asset_id") or "").strip()
        if aid not in want:
            continue
        try:
            # 300s per row: research-time fetch is opportunistic — a stalled
            # video download must never hold the single-threaded bridge for
            # the full gated-download hour (the row is disclosed as failed and
            # the user can still fetch it via the gated path later).
            saved = _download_asset_row(project, row, ytdlp_timeout_s=300)
            results.append({
                **row,
                "saved_path": str(saved.relative_to(project)),
                "sha256": sha256(saved),
                "bytes": saved.stat().st_size,
            })
            downloaded += 1
        except Exception as exc:
            results.append({**row, "error": f"{type(exc).__name__}: {exc}"})
            failed += 1
    saved_rows = [r for r in results if "saved_path" in r]
    if saved_rows:
        for r in saved_rows:
            r["notes"] = f"{(r.get('notes') or '').strip()} | auto-fetched during research; rights review still required".strip(" |")
        ledger.record_downloads(project, saved_rows)
    return {"downloaded": downloaded, "failed": failed, "rows": results}


@method("assets.save_screenshot")
def assets_save_screenshot(params: dict) -> dict:
    """Persist a Scout page screenshot into the project (media/screenshots/),
    register it as a media candidate (provider=screenshot), and record
    provenance — screenshots of key pages are film material like any other."""
    _require_dwk()
    project = _project(params)
    b64 = str(params.get("jpeg_base64") or "")
    url = str(params.get("url") or "")
    title = str(params.get("title") or "")
    if not b64:
        raise ValueError("jpeg_base64 is required")
    raw = base64.b64decode(b64, validate=False)
    if len(raw) > 8_000_000:
        raise ValueError("screenshot exceeds 8MB limit")
    if len(raw) < 500:
        raise ValueError("screenshot too small to be a real capture")
    folder = project / "media" / "screenshots"
    folder.mkdir(parents=True, exist_ok=True)
    host = urlsplit(url).hostname or "page"
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", f"{host}_{title}").strip("._")[:60] or "page"
    out = folder / f"{slug}_{int(time.time())}.jpg"
    out.write_bytes(raw)
    row = {
        "provider": "screenshot",
        "title": f"Screenshot: {title or host}"[:120],
        "asset_page_url": url,
        "download_url": url,
        "filename": out.name,
        "media_type": "image",
        "license": "self-captured screenshot (editorial reference)",
        "notes": "Page screenshot captured by Scout during research; saved locally for the edit.",
    }
    res = ledger.append_asset_candidates(project, [row])
    saved = res["saved"]
    if saved:
        ledger.record_downloads(project, [{
            **saved[0],
            "saved_path": str(out.relative_to(project)),
            "sha256": sha256(out),
            "bytes": len(raw),
            "notes": "page screenshot captured during research (self-captured, editorial reference)",
        }])
    return {"ok": True, "path": str(out.relative_to(project)), "asset_id": saved[0]["asset_id"] if saved else None}


@method("ytdlp.search")
def ytdlp_search(params: dict) -> dict:
    """Enumerate YouTube search results via yt-dlp flat playlist (no download,
    no API key). Returns {title, url, duration_s} rows for video proposals."""
    query = str(params.get("query") or "").strip()
    if not query:
        raise ValueError("query is required")
    limit = max(1, min(int(params.get("limit") or 6), 12))
    exe = shutil.which("yt-dlp")
    if not exe:
        raise RuntimeError("yt-dlp is not installed or not on PATH")
    template = json.dumps({"title": "%(title)s", "url": "%(webpage_url)s", "duration": "%(duration)s"})
    proc = subprocess.run(
        [exe, "--flat-playlist", "--print", template, f"ytsearch{limit}:{query}"],
        capture_output=True, text=True, timeout=180,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"yt-dlp search failed: {(proc.stderr or proc.stdout or '')[-200:]}")
    rows = []
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            item = json.loads(line)
            url = str(item.get("url") or "")
            if not url:
                continue
            parsed = urlsplit(url)
            # Flat-playlist search sometimes surfaces non-watch URLs (storefront/
            # feed/browse pages) — downloading those pulls random featured
            # videos, not the searched content.
            if parsed.netloc.lower().endswith("youtube.com") and not parsed.path.startswith("/watch"):
                continue
            rows.append({
                "title": str(item.get("title") or "")[:120],
                "url": url,
                "duration_s": item.get("duration") if isinstance(item.get("duration"), (int, float)) else None,
            })
        except json.JSONDecodeError:
            continue
    return {"count": len(rows), "rows": rows}


@method("ytdlp.download")
def ytdlp_download(params: dict) -> dict:
    project = _project(params)
    url = str(params.get("url") or "").strip()
    assert_public_http_url(url)
    exe = shutil.which("yt-dlp")
    if not exe:
        raise RuntimeError("yt-dlp is not installed or not on PATH")
    folder = project / "media" / ("audio" if str(params.get("media_type")) == "audio" else "video")
    folder.mkdir(parents=True, exist_ok=True)
    template = str(folder / "%(title).80s.%(ext)s")
    proc = subprocess.run(
        [exe, "-f", "mp4/best", "--no-playlist", "--no-progress", "-o", template, "--", url],
        capture_output=True,
        text=True,
        timeout=1800,
    )
    saved = sorted(folder.glob("*"), key=lambda p: p.stat().st_mtime)[-1:] if proc.returncode == 0 else []
    return {
        "exit_code": proc.returncode,
        "output": (proc.stdout or "")[-2000:],
        "errors": (proc.stderr or "")[-2000:],
        "saved_path": str(saved[0].relative_to(project)) if saved else None,
    }


# --------------------------------------------------------------------- tts
# TTS subsystem (TAD §8): edge-tts neural voices with word-boundary events,
# ffmpeg conversion to 48 kHz stereo WAV, content-hash cache under
# production/vo/cache/, and an offline SAPI fallback (PowerShell System.Speech)
# that is always disclosed in the result ("engine": "sapi", words: null).
#
# Craft pass (docs/research/DOCUMENTARY-CRAFT-RESEARCH.md §5.5): every TTS
# output runs through a broadcast VO chain — HPF 80 Hz (rumble) → de-esser
# (sibilance) → gentle 2.5:1 compression → limiter. Word timings come from
# edge metadata and are unaffected. Bump VO_CHAIN_VERSION when the chain
# changes so cached WAVs re-render.

VO_CHAIN_VERSION = "v2"
VO_FILTER_CHAIN = (
    "highpass=f=80,"
    "deesser=i=0.4,"
    "acompressor=threshold=0.126:ratio=2.5:attack=15:release=120:makeup=1.5,"
    "alimiter=limit=0.95:level=0"
)

def _fmt_rate(rate_pct: object) -> str:
    try:
        pct = float(rate_pct)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        pct = 0.0
    pct = max(-50.0, min(50.0, pct))
    return f"{pct:+g}%"


def _rate_pct_value(rate_pct: object) -> float:
    try:
        return max(-50.0, min(50.0, float(rate_pct)))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


def _cache_key(text: str, voice: str, rate: str) -> str:
    import hashlib

    # Key includes the VO chain version: cached WAVs from an older chain
    # (raw, unprocessed) must re-render rather than be reused.
    return hashlib.sha256(f"{text}|{voice}|{rate}|{VO_CHAIN_VERSION}".encode("utf-8")).hexdigest()[:32]


def _audio_duration_s(path: Path) -> float:
    try:
        proc = subprocess.run(
            [ffprobe_path(), "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        return float(json.loads(proc.stdout or "{}").get("format", {}).get("duration") or 0.0)
    except Exception:
        return 0.0


def _to_wav_48k(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part.wav")
    proc = subprocess.run(
        [
            ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
            "-af", VO_FILTER_CHAIN, "-ar", "48000", "-ac", "2", str(tmp),
        ],
        capture_output=True, text=True, timeout=300,
    )
    if proc.returncode != 0 or not tmp.exists():
        raise RuntimeError(f"ffmpeg WAV conversion failed: {(proc.stderr or '')[-200:]}")
    tmp.replace(dest)


def _apply_vo_chain_inplace(wav: Path) -> None:
    """Same broadcast chain for the SAPI fallback path (in-place, keeps channels)."""
    tmp = wav.with_suffix(wav.suffix + ".vo.wav")
    proc = subprocess.run(
        [ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav), "-af", VO_FILTER_CHAIN, "-ar", "48000", str(tmp)],
        capture_output=True, text=True, timeout=300,
    )
    if proc.returncode != 0 or not tmp.exists():
        raise RuntimeError(f"VO chain failed: {(proc.stderr or '')[-200:]}")
    tmp.replace(wav)


def _sapi_synthesize(text: str, out_wav: Path, rate_pct: float) -> None:
    """Offline fallback: Windows SAPI via PowerShell System.Speech (TAD §8).
    No word boundaries — the caller discloses words: null for this engine."""
    import tempfile

    try:
        rate_int = max(-10, min(10, round(float(rate_pct) / 10.0)))
    except (TypeError, ValueError):
        rate_int = 0
    with tempfile.TemporaryDirectory(prefix="sapi-tts-") as td:
        script = Path(td) / "tts.ps1"
        textfile = Path(td) / "narration.txt"
        textfile.write_text(text, encoding="utf-8-sig")

        def psq(p: Path) -> str:  # PowerShell single-quoted string escape
            return str(p.resolve()).replace("'", "''")

        script.write_text(
            "Add-Type -AssemblyName System.Speech\n"
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\n"
            f"$s.Rate = {rate_int}\n"
            f"$s.SetOutputToWaveFile('{psq(out_wav)}', "
            "(New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, "
            "[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, "
            "[System.Speech.AudioFormat.AudioChannel]::Mono)))\n"
            f"$t = Get-Content -Raw '{psq(textfile)}'\n"
            "$s.Speak($t)\n"
            "$s.Dispose()\n",
            encoding="utf-8-sig",
        )
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
            capture_output=True, text=True, timeout=900,
        )
    if proc.returncode != 0 or not out_wav.exists():
        raise RuntimeError(f"SAPI TTS failed: {(proc.stderr or proc.stdout or '')[-200:]}")


@method("tts.voices")
def tts_voices(params: dict) -> dict:
    if _EDGE_LOAD_ERROR is not None:
        raise RuntimeError(f"edge-tts not available ({_EDGE_LOAD_ERROR})")
    import asyncio

    async def _list():
        return await edge_tts.list_voices()

    voices = asyncio.run(_list())
    locale = str(params.get("locale") or "").strip().lower()
    if locale:
        voices = [v for v in voices if str(v.get("Locale", "")).lower().startswith(locale)]
    rows = [
        {
            "short_name": v.get("ShortName"),
            "gender": v.get("Gender"),
            "locale": v.get("Locale"),
            "name": v.get("FriendlyName"),
        }
        for v in voices
    ]
    return {"count": len(rows), "voices": rows}


def _edge_generate(text: str, voice: str, rate: str) -> tuple[bytes, list[dict]]:
    """Stream edge-tts: raw mp3 audio bytes + WordBoundary events. Boundary
    offsets/durations are 100-ns ticks — 1e7 ticks per second."""
    import asyncio

    async def _gen():
        c = edge_tts.Communicate(text, voice, rate=rate, volume="+0%", pitch="+0Hz", boundary="WordBoundary")
        audio = bytearray()
        words: list[dict] = []
        async for ch in c.stream():
            if ch["type"] == "audio":
                audio += ch["data"]
            elif ch["type"] == "WordBoundary":
                words.append({
                    "word": str(ch.get("text") or ""),
                    "start_s": round(float(ch.get("offset") or 0) / 1e7, 3),
                    "dur_s": round(float(ch.get("duration") or 0) / 1e7, 3),
                })
        return bytes(audio), words

    return asyncio.run(_gen())


@method("tts.generate")
def tts_generate(params: dict) -> dict:
    """One narration section → production/vo/<name>.wav (48 kHz stereo) +
    <name>.words.json (word timings for SRT and shot alignment). Edge engine
    results are cached by sha256(text|voice|rate); SAPI fallback never caches
    and never carries word timings."""
    _require_dwk()
    project = _project(params)
    text = str(params.get("text") or "").strip()
    if not text:
        raise ValueError("text is required")
    if len(text) > 10_000:
        raise ValueError("text exceeds 10000 chars — one section per generate call")
    voice = str(params.get("voice") or "en-US-AndrewMultilingualNeural")
    rate_pct = _rate_pct_value(params.get("rate_pct"))
    rate = _fmt_rate(rate_pct)
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", str(params.get("out_name") or "narration")).strip("._-")[:60] or "narration"
    to_preview = params.get("preview") is True

    vo_dir = project / "studio" / "preview" if to_preview else project / "production" / "vo"
    cache_dir = project / "production" / "vo" / "cache"
    vo_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = _cache_key(text, voice, rate)
    dest_wav = vo_dir / f"{name}.wav"

    engine = "edge"
    words: list[dict] | None = None
    cached = False
    cache_mp3 = cache_dir / f"{key}.mp3"
    cache_words = cache_dir / f"{key}.words.json"
    cache_wav = cache_dir / f"{key}.wav"

    if cache_wav.exists():
        cached = True
        shutil.copyfile(cache_wav, dest_wav)
        if cache_words.exists():
            try:
                words = json.loads(cache_words.read_text(encoding="utf-8"))
            except Exception:
                words = None
    else:
        audio: bytes | None = None
        if _EDGE_LOAD_ERROR is None:
            # edge-tts is unofficial and flaky: transient NoAudioReceived/403s
            # clear on retry (AGENT-SPEC §7 backoff), so try twice before the
            # disclosed SAPI fallback.
            last_edge_error: Exception | None = None
            for attempt in (1, 2):
                try:
                    audio, words = _edge_generate(text, voice, rate)
                    if not audio:
                        raise RuntimeError("edge-tts returned no audio")
                    break
                except Exception as exc:
                    last_edge_error = exc
                    audio = None
                    words = None
                    if attempt == 1:
                        time.sleep(1.5)
            if audio is None and last_edge_error is not None:
                log(f"edge-tts failed ({type(last_edge_error).__name__}: {last_edge_error}) — falling back to SAPI")
        if audio is not None:
            cache_mp3.write_bytes(audio)
            try:
                _to_wav_48k(cache_mp3, cache_wav)
                cache_words.write_text(json.dumps(words or []), encoding="utf-8")
            except Exception:
                cache_mp3.unlink(missing_ok=True)
                raise
            shutil.copyfile(cache_wav, dest_wav)
        else:
            engine = "sapi"
            words = None
            _sapi_synthesize(text, dest_wav, rate_pct)
            try:
                _apply_vo_chain_inplace(dest_wav)
            except Exception as exc:
                # The fallback must stay usable even if the chain fails — disclose, keep raw.
                log(f"VO chain skipped on SAPI output: {exc}")
            cached = False

    duration = _audio_duration_s(dest_wav)
    out_words = None
    if words:
        dest_words = vo_dir / f"{name}.words.json"
        dest_words.write_text(json.dumps(words), encoding="utf-8")
        out_words = str(dest_words.relative_to(project))
    return {
        "engine": engine,
        "voice": voice if engine == "edge" else "sapi-fallback",
        "rate": rate,
        "wav": str(dest_wav.relative_to(project)),
        "words": out_words,
        "words_count": len(words or []),
        "duration_s": round(duration, 3),
        "cache_key": key,
        "cached": cached,
        "bytes": dest_wav.stat().st_size,
    }


@method("tts.preview")
def tts_preview(params: dict) -> dict:
    """Voice sample for gate G-D: short text → studio/preview/voice_preview.wav."""
    params = dict(params)
    params["preview"] = True
    params.setdefault("out_name", "voice_preview")
    return tts_generate(params)


@method("dwk.validate_srt")
def dwk_validate_srt_method(params: dict) -> dict:
    _require_dwk()
    srt = _as_path(params["srt_path"]).resolve()
    if not srt.is_file():
        raise ValueError(f"srt not found: {srt}")
    max_cps = float(params.get("max_cps") or 20.0)
    return dwk_validate_srt(srt, max_cps)


# --------------------------------------------------- dwk production (M3)

@method("dwk.finalize")
def dwk_finalize_method(params: dict) -> dict:
    """DWK finalize: mux picture + narration (+ optional ducked music, + SRT)
    into the delivery master. Duration is passed explicitly by the Producer
    pipeline (VO-summed timeline) — never guessed from target_runtime."""
    _require_dwk()
    project = _project(params)

    def opt(key: str) -> Path | None:
        raw = params.get(key)
        return _project_rel(project, raw) if raw else None

    picture = opt("picture")
    narration = opt("narration")
    if picture is None or narration is None:
        raise ValueError("picture and narration are required")
    output = _project_rel(project, params["output"])
    duration = float(params["duration"]) if params.get("duration") else None
    music_gain_db = float(params.get("music_gain_db") if params.get("music_gain_db") is not None else -9.0)
    sidechain_threshold = float(params.get("sidechain_threshold") if params.get("sidechain_threshold") is not None else 0.18)
    dwk_finalize(
        project,
        picture.resolve(),
        narration.resolve(),
        music.resolve() if (music := opt("music")) else None,
        subtitles.resolve() if (subtitles := opt("subtitles")) else None,
        output.resolve(),
        duration,
        music_gain_db,
        sidechain_threshold,
    )
    if not output.is_file():
        raise RuntimeError("finalize produced no output file")
    return {
        "output": str(output),
        "bytes": output.stat().st_size,
        "duration_s": round(_audio_duration_s(output), 3),
        "music": bool(music),
        "subtitles": bool(subtitles),
    }


@method("dwk.qc")
def dwk_qc_method(params: dict) -> dict:
    """DWK-grade QC: stream metadata + expected-vs-actual + full decode of the
    final documentary; writes qc/qc_report.json (DATA-SCHEMA §2)."""
    _require_dwk()
    project = _project(params)
    video = _project_rel(project, params["video"]).resolve()
    if not video.is_file():
        raise ValueError(f"video not found: {video}")
    expected_duration = float(params["expected_duration"]) if params.get("expected_duration") else None
    expected_width = int(params["width"]) if params.get("width") else None
    expected_height = int(params["height"]) if params.get("height") else None
    expected_fps = float(params["fps"]) if params.get("fps") else None
    tolerance = float(params.get("duration_tolerance") or 0.5)
    info = dwk_qc_inspect(video)
    errors: list[str] = []
    if expected_width and info.get("width") != expected_width:
        errors.append(f"Expected width={expected_width}, got {info.get('width')}")
    if expected_height and info.get("height") != expected_height:
        errors.append(f"Expected height={expected_height}, got {info.get('height')}")
    if expected_fps and info.get("fps") is not None and abs(info["fps"] - expected_fps) > 0.01:
        errors.append(f"Expected {expected_fps} fps, got {info.get('fps')}")
    if not info.get("audio_stream"):
        errors.append("No audio stream found")
    if expected_duration and info.get("duration_seconds") and abs(info["duration_seconds"] - expected_duration) > tolerance:
        errors.append(f"Runtime differs from expected {expected_duration:.3f}s")
    ff = ffmpeg_path()
    decode = subprocess.run(
        [ff, "-hide_banner", "-v", "error", "-i", str(video), "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"],
        text=True, capture_output=True,
    )
    if decode.returncode != 0:
        errors.append("Full video/audio decode failed: " + (decode.stderr or "")[-1200:])
    if (project / "production").exists():
        srt_files = [s for s in (project / "production").glob("subtitles*.srt") if s.stat().st_size > 0]
        if srt_files and info.get("subtitle_streams", 0) == 0:
            errors.append("Subtitle sidecar exists but no subtitle stream is muxed into MP4")
    report = {
        "video": str(video),
        "expected": {"width": expected_width, "height": expected_height, "fps": expected_fps, "duration": expected_duration},
        "streams": info,
        "full_video_audio_decode": "passed" if decode.returncode == 0 else "failed",
        "errors": errors,
        "passed": not errors,
    }
    out = project / "qc" / "qc_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return report


@method("dwk.package_project")
def dwk_package_method(params: dict) -> dict:
    """Gate G-F executes here: DWK package_project → delivery/project.zip + sha256.
    The Studio wrapper then repacks the ZIP without the regenerable visual-QC
    frame cache (qc/visual_frames/, DATA-SCHEMA §10 exclusion) — DWK's packager
    walks the whole project and must stay untouched."""
    _require_dwk()
    project = _project(params)
    output = _project_rel(project, params.get("output") or (project / "delivery" / "project.zip"))
    include_research = params.get("include_research_copies") is True
    dwk_package(project, output.resolve(), include_research)
    stripped = qc_scan.exclude_frames_from_zip(output.resolve())
    sha_file = output.with_suffix(output.suffix + ".sha256")
    return {
        "zip": str(output),
        "bytes": output.stat().st_size,
        "sha256": sha_file.read_text(encoding="ascii").split()[0] if sha_file.is_file() else None,
        "visual_frames_stripped": stripped,
    }


@method("dwk.render_video")
def dwk_render_video_method(params: dict) -> dict:
    """DWK ffmpeg picture render from the frame-contiguous shot_list.csv —
    the compositions-free fallback master (no Ken Burns; scale+crop only)."""
    _require_dwk()
    project = _project(params)
    shots = _project_rel(project, params.get("shots") or (project / "production" / "shot_list.csv"))
    if not shots.is_file():
        raise ValueError("shot_list.csv not found")
    output = _project_rel(project, params["output"])
    width = int(params.get("width") or 1920)
    height = int(params.get("height") or 1080)
    fps = int(params.get("fps") or 30)
    dwk_render_video(shots.resolve(), output.resolve(), width, height, fps, project.resolve())
    if not output.is_file():
        raise RuntimeError("render_video produced no output file")
    return {"output": str(output), "bytes": output.stat().st_size}


# -------------------------------------------------------------------- main

def send(frame: dict) -> None:
    # ensure_ascii keeps every protocol frame pure ASCII — immune to any
    # console codec (the receiver's JSON parser decodes \uXXXX identically).
    # A lock keeps concurrent handler threads from interleaving half-frames.
    with PROTO_LOCK:
        PROTO.write(json.dumps(frame, ensure_ascii=True) + "\n")
        PROTO.flush()


def log(msg: str) -> None:
    print(f"[bridge] {msg}", file=sys.stderr, flush=True)


def reply(rid, result=None, error=None) -> None:
    frame = {"jsonrpc": "2.0", "id": rid}
    if error is not None:
        frame["error"] = error
    else:
        frame["result"] = result
    send(frame)


def dispatch(req: dict) -> None:
    rid = req.get("id")
    name = req.get("method")
    handler = METHODS.get(name)
    if handler is None:
        if rid is not None:
            reply(rid, error={"code": -32601, "message": f"Method not found: {name}"})
        return
    try:
        result = handler(req.get("params") or {})
        if rid is not None:
            reply(rid, result=result)
    except Exception as exc:  # noqa: BLE001 — report every failure to the host
        if rid is not None:
            reply(
                rid,
                error={
                    "code": -32000,
                    "message": f"{type(exc).__name__}: {exc}",
                    "data": traceback.format_exc(limit=8),
                },
            )
        log(f"error in {name}: {type(exc).__name__}: {exc}")


def main() -> int:
    log(f"studio bridge {VERSION} starting (python {sys.version.split()[0]}, dwk_root={DWK_ROOT})")
    # Handlers run on a small worker pool: one slow request (a full-decode
    # ffmpeg probe, a large download) must not starve the ones queued behind
    # it. That starvation made `dwk.validate_project` — a 0.02s file read —
    # time out at 60s while a video thumbnail decoded (2026-11-19).
    pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="bridge")
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {exc}"}})
                continue
            if isinstance(req, dict) and "method" in req:
                dispatch(req)  # TEMP-SERIAL-CHECK
    finally:
        pool.shutdown(wait=True)
    log("stdin closed — exiting")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
