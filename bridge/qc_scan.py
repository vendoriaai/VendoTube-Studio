"""Visual QC Layer 0 (M7) — deterministic ffmpeg detectors + frame sampling.

Everything in this module is local-only (PRD R11): the rendered master is
decoded by the DWK ffmpeg binary, findings are parsed from detector logs, and
sampled frames stay inside the project's `qc/visual_frames/` cache. No
network, no AI. The Node side (src/main/producer/visualQc.ts) classifies the
raw detector output into findings with severities — this module only reports
what the detectors measured, so it stays trivially testable.
"""
from __future__ import annotations

import re
import subprocess
import zipfile
from pathlib import Path

FRAMES_DIR_SEGMENTS = ("qc", "visual_frames")
# Source-clip stills for the video-moment picker (one dir per clip+shot).
SOURCE_FRAMES_DIR_SEGMENTS = ("studio", "video_frames")
SAMPLE_BUDGET = 600  # hard ceiling; the Node caller plans within the same budget


def _run(args: list[str], timeout: int) -> subprocess.CompletedProcess:
    # shell=False (the default, explicit here for review): every value — media
    # path, thresholds — travels as a separate argv element, never inside a
    # shell command line. Paths resolve against the project via _project_rel.
    return subprocess.run(args, capture_output=True, text=True, errors="replace", timeout=timeout, shell=False)


def _probe_duration(media: Path) -> float:
    proc = _run(
        [_ffprobe_bin(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(media)],
        timeout=60,
    )
    try:
        return float((proc.stdout or "").strip().splitlines()[0])
    except (ValueError, IndexError):
        return 0.0


# Imported lazily by server.py so this module stays importable without DWK.
def _ffbin() -> str:
    from workflow.common import ffmpeg_path

    return ffmpeg_path()


def _ffprobe_bin() -> str:
    from workflow.common import ffprobe_path

    return ffprobe_path()


def scan_master(
    media: Path,
    black_min_s: float = 0.5,
    freeze_min_s: float = 2.0,
    silence_min_s: float = 1.0,
    scene_thresh: float = 0.2,
    timeout: int = 3600,
) -> dict:
    """Run blackdetect/freezedetect/silencedetect + scene-cut detection on the
    rendered master (two decode passes, same as dwk.qc's full decode). Returns
    RAW ranges/cut times — classification into findings happens in the Node
    pipeline where the composition timings are known."""
    ff = _ffbin()
    duration = _probe_duration(media)

    # Pass 1 — one decode, three detectors reporting to stderr. NB: ffmpeg's
    # detector log formats are inconsistent — blackdetect prints
    # `black_start:3` (no space) while silencedetect/freezedetect print
    # `silence_start: 4.01` (with space) — every regex below allows both.
    vf = (
        f"blackdetect=d={black_min_s:g}:pix_th=0.10,"
        f"freezedetect=n=-60dB:d={freeze_min_s:g}"
    )
    af = f"silencedetect=n=-40dB:d={silence_min_s:g}"
    p1 = _run([ff, "-hide_banner", "-nostats", "-i", str(media), "-vf", vf, "-af", af, "-f", "null", "-"], timeout)
    err = p1.stderr or ""

    black = [
        {"from_s": round(float(a), 3), "to_s": round(float(b), 3)}
        for a, b in re.findall(r"black_start:\s*([\d.]+) black_end:\s*([\d.]+) black_duration:\s*[\d.]+", err)
    ]
    # freezedetect pairs `freeze_start` with the NEXT `freeze_duration`; a
    # freeze still open at EOF never gets one — close it at the measured
    # stream duration (a frozen tail is exactly what that is).
    freeze = _pair_freeze(err, duration)
    # Silence pairs interleave as `silence_start: X` … `silence_end: Y | silence_duration: D`
    # lines — pair them sequentially instead of regex-guessing across lines.
    silence = _pair_silence(err)

    # Pass 2 — scene-change timestamps (cut assertion input).
    p2 = _run(
        [ff, "-hide_banner", "-nostats", "-an", "-i", str(media), "-vf", f"select='gt(scene,{scene_thresh:g})',showinfo", "-f", "null", "-"],
        timeout,
    )
    raw_cuts = [float(m) for m in re.findall(r"pts_time:([\d.]+)", p2.stderr or "")]
    cuts: list[float] = []
    for t in sorted(raw_cuts):
        if cuts and t - cuts[-1] < 0.3:  # debounce: one cut per transition
            continue
        cuts.append(round(t, 3))

    sha = _sha256(media)
    return {
        "sha256": sha,
        "sha8": sha[:8],
        "duration_s": round(_probe_duration(media), 3),
        "black": black,
        "freeze": freeze,
        "silence": silence,
        "cuts": cuts,
        "detectors": {
            "black_min_s": black_min_s,
            "freeze_min_s": freeze_min_s,
            "silence_min_s": silence_min_s,
            "scene_thresh": scene_thresh,
        },
    }


def _pair_freeze(err: str, fallback_end: float) -> list[dict]:
    """Pair freeze_start with the NEXT freeze_duration (freeze_end follows it);
    a freeze open at EOF closes at the measured stream duration."""
    ranges: list[dict] = []
    open_start: float | None = None
    for line in err.splitlines():
        m = re.search(r"freeze_start:\s*([\d.]+)", line)
        if m:
            open_start = float(m.group(1))
            continue
        m = re.search(r"freeze_duration:\s*([\d.]+)", line)
        if m and open_start is not None:
            ranges.append({"from_s": round(open_start, 3), "to_s": round(open_start + float(m.group(1)), 3)})
            open_start = None
    if open_start is not None:
        ranges.append({"from_s": round(open_start, 3), "to_s": round(fallback_end, 3)})
    return ranges


def _pair_silence(err: str) -> list[dict]:
    """Pair interleaved silence_start/silence_end lines into ranges."""
    ranges: list[dict] = []
    open_start: float | None = None
    for line in err.splitlines():
        m = re.search(r"silence_start:\s*(-?[\d.]+)", line)
        if m:
            open_start = max(0.0, float(m.group(1)))
            continue
        m = re.search(r"silence_end:\s*([\d.]+)", line)
        if m and open_start is not None:
            ranges.append({"from_s": round(open_start, 3), "to_s": round(float(m.group(1)), 3)})
            open_start = None
    return ranges


def extract_frames(
    media: Path,
    times: list[float],
    out_dir: Path,
    project: Path,
    width: int = 768,
    quality: int = 4,
    timeout: int = 3600,
) -> list[dict]:
    """Extract one JPEG per timestamp into `out_dir` (seek-then-single-frame).

    Shared by the visual-QC sampler and by the video-moment picker, which
    samples a DOWNLOADED SOURCE clip (not the master) at candidate in-points.
    Returns [{t_s, path}] with project-relative paths; timestamps that produce
    no frame are skipped rather than erroring the whole sampling run.
    """
    if len(times) > SAMPLE_BUDGET:
        raise ValueError(f"frame extraction budget exceeded: {len(times)} > {SAMPLE_BUDGET}")
    out_dir.mkdir(parents=True, exist_ok=True)
    ff = _ffbin()
    written: list[dict] = []
    for t in times:
        ms = int(round(t * 1000))
        out = out_dir / f"f_{ms:07d}.jpg"
        _run(
            [ff, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{max(0.0, t):.3f}", "-i", str(media),
             "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", str(quality), str(out)],
            timeout=timeout,
        )
        if out.is_file():
            written.append({"t_s": round(max(0.0, t), 3), "path": str(out.relative_to(project)).replace("\\", "/")})
    return written


def sample_frames(media: Path, times: list[float], sha8: str, project: Path, width: int = 768, timeout: int = 3600) -> dict:
    """Extract JPEG stills at the given master-clock timestamps into the
    regenerable cache `qc/visual_frames/<sha8>/` (DATA-SCHEMA §7.2). The
    budget ceiling is enforced here defensively; the caller plans the list."""
    out_dir = project.joinpath(*FRAMES_DIR_SEGMENTS, sha8)
    written = extract_frames(media, times, out_dir, project, width=width, timeout=timeout)
    return {
        "dir": "/".join(FRAMES_DIR_SEGMENTS) + f"/{sha8}",
        "frames": [f["path"] for f in written],
        "requested": len(times),
    }


def source_frames(
    media: Path,
    times: list[float],
    tag: str,
    project: Path,
    width: int = 512,
    timeout: int = 3600,
) -> dict:
    """Sample a SOURCE clip (a downloaded research video) at candidate
    in-points, into the regenerable cache `studio/video_frames/<tag>/`.

    The moment picker looks at these stills to choose which seconds of a clip
    illustrate a scene (2026-11-19). `tag` namespaces one clip's frames so two
    shots from the same source never overwrite each other's candidates.
    """
    out_dir = project.joinpath(*SOURCE_FRAMES_DIR_SEGMENTS, tag)
    frames = extract_frames(media, times, out_dir, project, width=width, quality=5, timeout=timeout)
    return {
        "dir": "/".join(SOURCE_FRAMES_DIR_SEGMENTS) + f"/{tag}",
        "duration_s": round(_probe_duration(media), 3),
        "frames": frames,
        "requested": len(times),
    }



def exclude_frames_from_zip(zip_path: Path) -> int:
    """Repack the delivery ZIP without `qc/visual_frames/` entries (DATA-SCHEMA
    §10 exclusion). DWK's packager walks the whole project and must stay
    untouched, so the Studio bridge wrapper calls this after packaging. A zip
    without frame entries is left byte-identical (returns 0)."""
    with zipfile.ZipFile(zip_path, "r") as z:
        names = z.namelist()
    doomed = [n for n in names if "/".join(FRAMES_DIR_SEGMENTS) in Path(n).parts]
    if not doomed:
        return 0
    tmp = zip_path.with_suffix(".zip.repack")
    with zipfile.ZipFile(zip_path, "r") as src, zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as dst:
        for info in src.infolist():
            if info.filename in set(doomed):
                continue
            dst.writestr(info, src.read(info.filename))
    tmp.replace(zip_path)
    # Refresh the sha256 sidecar — DWK wrote it for the original zip.
    import hashlib

    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    sidecar = zip_path.with_suffix(zip_path.suffix + ".sha256")
    sidecar.write_text(f"{digest}  {zip_path.name}\n", encoding="ascii")
    return len(doomed)


def _sha256(path: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()
