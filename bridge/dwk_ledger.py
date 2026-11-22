"""CSV ledger operations on DWK project files.

Reads/writes the exact DWK schemas (workflow.init_project.HEADERS). Appending
never destroys DWK compatibility: DictReader-based CLI tools tolerate extra
columns, and this module only *adds* optional provenance columns to
assets_to_download.csv (title/date/rights_statement from discovery metadata).
"""
from __future__ import annotations

import csv
import datetime
from pathlib import Path

from workflow.init_project import HEADERS  # the DWK schema, verbatim

ASSET_EXTRA = ("title", "date", "rights_statement")
_ASSET_REL = "research/assets_to_download.csv"


def _project(project_path: str | Path) -> Path:
    p = Path(project_path).expanduser().resolve()
    if not (p / "project.yml").exists():
        raise ValueError(f"not a documentary project: {p}")
    return p


def _rel(project: Path, rel: str) -> Path:
    return project / rel


def read_rows(project_path: str | Path, rel: str) -> list[dict]:
    path = _rel(_project(project_path), rel)
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as f:
        return [dict(r) for r in csv.DictReader(f)]


def _write_all(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def _append(project_path: str | Path, rel: str, rows: list[dict], extra_fields: tuple[str, ...] = ()) -> list[dict]:
    """Append rows, upgrading the header to a union when extra fields appear."""
    if not rows:
        return []
    project = _project(project_path)
    path = _rel(project, rel)
    base_headers = list(HEADERS[rel])
    existing: list[dict] = []
    current_headers = base_headers
    if path.exists() and path.stat().st_size > 0:
        existing = read_rows(project, rel)
        with path.open(encoding="utf-8-sig", newline="") as f:
            current_headers = next(csv.reader(f), base_headers)
    headers = list(dict.fromkeys(current_headers + [c for c in extra_fields if c not in current_headers]))
    # coerce row keys to the schema; unknown keys are kept only if already in header
    # (None/missing → "", but integer 0 preserved — same 0-falsy rule as write_shot_list)
    cleaned = []
    for row in rows:
        rec = {k: ("" if row.get(k) is None else str(row.get(k))) for k in headers}
        cleaned.append(rec)
    _write_all(path, headers, existing + cleaned)
    return cleaned


def _next_ids(existing_rows: list[dict], prefix: str, column: str, count: int) -> list[str]:
    used = set()
    for r in existing_rows:
        v = (r.get(column) or "").strip()
        if v:
            used.add(v)
    out = []
    i = 1
    while len(out) < count:
        candidate = f"{prefix}-{i:04d}"
        if candidate not in used:
            out.append(candidate)
            used.add(candidate)
        i += 1
    return out


# ----------------------------------------------------------------- sources

def append_sources(project_path: str | Path, rows: list[dict]) -> dict:
    """Append sources; dedupe by URL. Assigns WEB-#### ids when missing.
    Returns {saved, skipped} so the agent can adapt when everything is a dupe."""
    rel = "research/sources.csv"
    existing = read_rows(project_path, rel)
    known_urls = {(r.get("url") or "").strip().rstrip("/") for r in existing}
    today = datetime.date.today().isoformat()
    fresh: list[dict] = []
    skipped = 0
    for row in rows:
        url = (row.get("url") or "").strip()
        if not url or url.rstrip("/") in known_urls:
            skipped += 1
            continue
        known_urls.add(url.rstrip("/"))
        fresh.append(row)
    if not fresh:
        return {"saved": [], "skipped": skipped}
    ids = _next_ids(existing, "WEB", "source_id", len(fresh))
    for row, sid in zip(fresh, ids):
        row.setdefault("source_id", sid)
        row.setdefault("accessed_date", today)
        row.setdefault("source_type", row.get("source_type") or "web")
    saved = _append(project_path, rel, fresh)
    return {"saved": saved, "skipped": skipped}


# ----------------------------------------------------------------- claims

def append_claims(project_path: str | Path, rows: list[dict]) -> dict:
    rel = "research/evidence_ledger.csv"
    existing = read_rows(project_path, rel)
    known_claims = {
        ((r.get("claim_text") or "").strip(), (r.get("source_id") or "").strip()) for r in existing
    }
    fresh: list[dict] = []
    skipped = 0
    for row in rows:
        key = ((row.get("claim_text") or "").strip(), (row.get("source_id") or "").strip())
        if key in known_claims:
            skipped += 1
            continue
        known_claims.add(key)
        fresh.append(row)
    if not fresh:
        return {"saved": [], "skipped": skipped}
    ids = _next_ids(existing, "CLM", "claim_id", len(fresh))
    for row, cid in zip(fresh, ids):
        row.setdefault("claim_id", cid)
        if not (row.get("claim_text") or "").strip():
            raise ValueError("claim_text is required for every claim")
        if not (row.get("source_id") or "").strip():
            raise ValueError(f"claim {row.get('claim_text', '')!r} is missing source_id")
    saved = _append(project_path, rel, fresh)
    return {"saved": saved, "skipped": skipped}


# ----------------------------------------------------------------- assets

def append_asset_candidates(project_path: str | Path, rows: list[dict]) -> dict:
    rel = _ASSET_REL
    existing = read_rows(project_path, rel)
    fresh: list[dict] = []
    skipped = 0
    # Dedupe on download URL + media type — multiple images harvested from the
    # same article page must each survive, and a video + audio pair of the same
    # source are legitimately separate assets.
    def media_key(r: dict) -> str:
        url = ((r.get("download_url") or "").strip() or (r.get("asset_page_url") or "").strip()).lower()
        return f"{url}|{(r.get('media_type') or '').strip().lower()}"

    known_media = {media_key(r) for r in existing if media_key(r)}
    for row in rows:
        key = media_key(row)
        if not key or key in known_media:
            skipped += 1
            continue
        known_media.add(key)
        row.setdefault("rights_status", "review")
        fresh.append(row)
    if not fresh:
        return {"saved": [], "skipped": skipped}
    ids = _next_ids(existing, "A", "asset_id", len(fresh))
    for row, aid in zip(fresh, ids):
        row["asset_id"] = aid
        row.setdefault("source_id", "")
        row.setdefault("attribution", "")
        row.setdefault("notes", "")
    saved = _append(project_path, rel, fresh, extra_fields=ASSET_EXTRA)
    return {"saved": saved, "skipped": skipped}


def set_rights_status(
    project_path: str | Path, asset_ids: list[str], rights_status: str, notes: str | None = None
) -> int:
    """Flip rights_status on manifest rows. This is the human G-C gate."""
    if rights_status not in ("review", "approved", "blocked"):
        raise ValueError("rights_status must be review|approved|blocked")
    rel = _ASSET_REL
    project = _project(project_path)
    rows = read_rows(project, rel)
    wanted = {a.strip() for a in asset_ids if a.strip()}
    changed = 0
    for row in rows:
        if (row.get("asset_id") or "").strip() in wanted:
            row["rights_status"] = rights_status
            if notes:
                row["notes"] = f"{(row.get('notes') or '').strip()} | {notes}".strip(" |")
            changed += 1
    if changed:
        headers = list(dict.fromkeys(list(HEADERS[rel]) + list(ASSET_EXTRA)))
        _write_all(_rel(project, rel), headers, rows)
    return changed


def list_assets(project_path: str | Path) -> dict:
    """Merged view for the Asset Library: candidates + downloaded overlay."""
    project = _project(project_path)
    candidates = read_rows(project, _ASSET_REL)
    downloaded = { (r.get("asset_id") or "").strip(): r for r in read_rows(project, "research/downloaded_assets.csv") if r.get("asset_id") }
    merged = []
    for row in candidates:
        rec = dict(row)
        dl = downloaded.get((row.get("asset_id") or "").strip())
        if dl:
            rec["saved_path"] = dl.get("saved_path", "")
            rec["sha256"] = dl.get("sha256", "")
            rec["bytes"] = dl.get("bytes", "")
        rec["downloaded"] = bool(dl)
        merged.append(rec)
    return {"candidates": merged, "downloaded_count": sum(1 for m in merged if m["downloaded"])}


def write_shot_list(project_path: str | Path, rows: list[dict]) -> dict:
    """Overwrite production/shot_list.csv with validated, frame-contiguous rows
    in the exact DWK schema. Raises on any timeline violation."""
    rel = "production/shot_list.csv"
    project = _project(project_path)
    headers = list(HEADERS[rel])
    last_end = None
    for i, row in enumerate(rows, 1):
        try:
            start, end = int(row["start_frame"]), int(row["end_frame"])
        except Exception:
            raise ValueError(f"shot row {i}: start_frame/end_frame must be integers")
        if end <= start:
            raise ValueError(f"shot row {i}: end_frame must exceed start_frame")
        if i == 1 and start != 0:
            raise ValueError("shot list must begin at frame 0")
        if last_end is not None and start != last_end:
            raise ValueError(f"shot row {i}: timeline gap/overlap (starts {start}, previous ended {last_end})")
        last_end = end
    # Coerce for CSV but PRESERVE integer 0 — `x or ""` is 0-falsy and used to
    # serialize the required first start_frame=0 as an empty cell, which
    # dwk.validate_project then rejected ("must be integers").
    cleaned = [{k: ("" if row.get(k) is None else str(row.get(k))) for k in headers} for row in rows]
    _write_all(_rel(project, rel), headers, cleaned)
    return {"count": len(cleaned)}


def record_downloads(project_path: str | Path, rows: list[dict]) -> int:
    """Append download provenance rows (saved_path/sha256/bytes) to the
    downloaded_assets ledger — used by the app-side unverified-media channel."""
    rel = "research/downloaded_assets.csv"
    project = _project(project_path)
    if not rows:
        return 0
    path = _rel(project, rel)
    fields = list(dict.fromkeys(k for r in rows for k in r))
    exists = path.exists() and path.stat().st_size > 0
    with path.open("a", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        if not exists:
            w.writeheader()
        w.writerows(rows)
    return len(rows)
