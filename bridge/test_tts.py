#!/usr/bin/env python3
"""M3 TTS subsystem round-trip test for the Studio Bridge.

Two layers:
  1. In-process (offline, deterministic): rate formatting, cache keys, the
     SAPI fallback synthesizer (real PowerShell System.Speech), WAV 48 kHz
     verification via ffprobe, and dwk.validate_srt on fixture SRTs.
  2. RPC-level (spawns bridge/server.py): dwk.init_project → tts.generate on
     the live edge-tts endpoint + cache-hit verification. These are warn-only:
     the edge endpoint is third-party and may refuse/rate-limit.

Run:  python bridge/test_tts.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent
SERVER = BRIDGE_DIR / "server.py"
sys.path.insert(0, str(BRIDGE_DIR))

failures: list[str] = []
warn_only: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"  ok   {name}")
    else:
        failures.append(f"{name}: {detail}")
        print(f"  FAIL {name} {detail}")


def softcheck(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"  ok   {name}")
    else:
        warn_only.append(f"{name}: {detail}")
        print(f"  warn {name} (live network — not a code failure) {detail}")


# ------------------------------------------------------------- in-process

import server  # noqa: E402  (imports DWK + guard; safe: server defers work to dispatch)

print("== in-process: offline units ==")

check("fmt_rate basic", server._fmt_rate(10) == "+10%")
check("fmt_rate negative", server._fmt_rate(-5) == "-5%")
check("fmt_rate clamps", server._fmt_rate(200) == "+50%")
check("fmt_rate junk", server._fmt_rate("x") == "+0%")
check("rate pct value", server._rate_pct_value(-12) == -12.0)
check("cache key stable", server._cache_key("a", "v", "+0%") == server._cache_key("a", "v", "+0%"))
check("cache key differs", server._cache_key("a", "v", "+0%") != server._cache_key("b", "v", "+0%"))

tmp = Path(tempfile.mkdtemp(prefix="vendotube-tts-"))
project = tmp / "proj"
project.mkdir()
(project / "project.yml").write_text("title: TTS Test\n", encoding="utf-8")

# SAPI fallback: real Windows synthesizer, offline, deterministic.
sapi_wav = project / "sapi_out.wav"
t0 = time.time()
try:
    server._sapi_synthesize("Testing the SAPI fallback path for narration.", sapi_wav, -2.0)
    check("sapi synthesizes", sapi_wav.is_file() and sapi_wav.stat().st_size > 10_000, "missing or tiny wav")
    dur = server._audio_duration_s(sapi_wav)
    check("sapi wav duration sane", 0.5 < dur < 30.0, f"duration={dur}")
    probe = json.loads(
        subprocess.run(
            [server.ffprobe_path(), "-v", "error", "-show_streams", "-of", "json", str(sapi_wav)],
            capture_output=True, text=True, timeout=30,
        ).stdout
    )
    a = next((s for s in probe.get("streams", []) if s.get("codec_type") == "audio"), {})
    check("sapi wav is 48 kHz", int(a.get("sample_rate") or 0) == 48000, f"rate={a.get('sample_rate')}")
    print(f"  ({time.time() - t0:.1f}s for SAPI synthesis)")
except Exception as exc:
    check("sapi synthesizes", False, f"{type(exc).__name__}: {exc}")

# Broadcast VO chain (craft pass): constants sane, cache key is versioned, and
# the in-place SAPI post-pass keeps the WAV playable.
check("vo chain versioned", server.VO_CHAIN_VERSION == "v2", server.VO_CHAIN_VERSION)
chain = server.VO_FILTER_CHAIN
check(
    "vo chain stages",
    all(s in chain for s in ("highpass", "deesser", "acompressor", "alimiter")),
    chain[:120],
)
old_key = server._cache_key("a", "v", "+0%")
server.VO_CHAIN_VERSION = "v1-forced"
bumped_key = server._cache_key("a", "v", "+0%")
server.VO_CHAIN_VERSION = "v2"
check("vo chain bumps cache key", old_key != bumped_key, "chain version ignored by cache key")
if sapi_wav.is_file():
    try:
        server._apply_vo_chain_inplace(sapi_wav)
        dur2 = server._audio_duration_s(sapi_wav)
        check(
            "vo chain keeps sapi wav valid",
            sapi_wav.is_file() and sapi_wav.stat().st_size > 10_000 and 0.5 < dur2 < 30.0,
            f"duration={dur2}",
        )
        check("vo chain no temp residue", not sapi_wav.with_suffix(sapi_wav.suffix + ".vo.wav").exists(), "leftover .vo.wav")
    except Exception as exc:
        check("vo chain keeps sapi wav valid", False, f"{type(exc).__name__}: {exc}")

# Edge WAV pipeline (offline half): hand a tiny mp3 through the converter.
edge_mp3 = tmp / "sample.mp3"
try:
    import edge_tts  # noqa: F401

    has_edge = True
except Exception:
    has_edge = False
if has_edge:
    # Synthesize a tiny sample first (live), then run the deterministic
    # mp3→WAV conversion + duration probe on it.
    try:
        import asyncio

        async def _tiny():
            c = edge_tts.Communicate("One two three.", "en-US-AndrewMultilingualNeural", boundary="WordBoundary")
            buf = bytearray()
            async for ch in c.stream():
                if ch["type"] == "audio":
                    buf += ch["data"]
            return bytes(buf)

        audio = asyncio.run(_tiny())
    except Exception:
        audio = b""
    if audio:
        edge_mp3.write_bytes(audio)
        wav48 = tmp / "sample.wav"
        server._to_wav_48k(edge_mp3, wav48)
        check("edge mp3 → 48k wav", wav48.is_file() and wav48.stat().st_size > 10_000, "missing or tiny wav")
        d = server._audio_duration_s(wav48)
        check("edge wav duration sane", 0.5 < d < 10.0, f"duration={d}")
        # part-file temp is replaced atomically
        check("no .part residue", not wav48.with_suffix(wav48.suffix + ".part.wav").exists())
    else:
        softcheck("edge tiny synth", False, "edge endpoint refused; converter test skipped")

# dwk.validate_srt — deterministic fixtures, RPC-level (below) and here via DWK import.
from workflow.validate_srt import validate as dwe_srt  # noqa: E402

good_srt = tmp / "good.srt"
good_srt.write_text(
    "1\n00:00:00,000 --> 00:00:02,000\nHello there, general.\n\n"
    "2\n00:00:02,100 --> 00:00:05,000\nThis is a second caption cue.\n",
    encoding="utf-8",
)
rep = dwe_srt(good_srt)
check("srt good fixture valid", rep["valid"] is True and rep["cue_count"] == 2, json.dumps(rep)[:200])
bad_srt = tmp / "bad.srt"
bad_srt.write_text(
    "1\n00:00:00,000 --> 00:00:00,000\nEnd before start.\n\n"
    "2\nnot a time line at all\nBroken cue.\n",
    encoding="utf-8",
)
rep = dwe_srt(bad_srt)
check("srt bad fixture invalid", rep["valid"] is False and len(rep["errors"]) >= 2, json.dumps(rep)[:200])
dense_srt = tmp / "dense.srt"
dense_srt.write_text(
    "1\n00:00:00,000 --> 00:00:01,000\n" + ("x" * 60) + "\n",
    encoding="utf-8",
)
rep = dwe_srt(dense_srt)
check("srt dense fixture warns", rep["valid"] is True and any("characters/second" in w for w in rep["warnings"]), json.dumps(rep)[:200])

# ------------------------------------------------------------- RPC layer

print("== rpc: bridge subprocess ==")
proc = subprocess.Popen(
    [sys.executable, str(SERVER)],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    encoding="utf-8",
    env={**shutil.os.environ, "PYTHONUNBUFFERED": "1"},
)
assert proc.stdin and proc.stdout

next_id = 0


def request(method: str, params: dict | None = None, timeout: float = 180.0) -> dict:
    global next_id
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
                raise RuntimeError(f"{method} failed: {msg['error'].get('message')}")
            return msg["result"]
    raise TimeoutError(f"{method} timed out after {timeout}s")


pong = request("sys.ping")
check("rpc ping", pong.get("ok") is True and pong.get("dwk_loaded") is True, str(pong)[:150])

# init a real project for generate paths
proj_path = tmp / "rpc-proj"
request("dwk.init_project", {"path": str(proj_path), "title": "TTS RPC", "fps": 30, "runtime": 120, "language": "en"})
check("rpc init project", (proj_path / "project.yml").is_file())

# tts.voices — live; warn-only
try:
    vs = request("tts.voices", {"locale": "en-US"}, timeout=60)
    softcheck("tts.voices en-US", vs.get("count", 0) > 5, f"count={vs.get('count')}")
    names = [v.get("short_name") for v in vs.get("voices", [])]
    softcheck("tts.voices has Andrew", "en-US-AndrewMultilingualNeural" in names, f"got {names[:5]}")
except Exception as exc:
    softcheck("tts.voices en-US", False, f"{type(exc).__name__}: {exc}")

TEXT = "Word boundaries let the studio sync subtitles and shot timing to narration."

# tts.generate — live edge; warn-only on endpoint failure but strict on contract
try:
    g1 = request(
        "tts.generate",
        {"project_path": str(proj_path), "text": TEXT, "voice": "en-US-AndrewMultilingualNeural", "rate_pct": 0, "out_name": "hook"},
        timeout=180,
    )
    softcheck("tts.generate edge engine", g1.get("engine") == "edge", f"engine={g1.get('engine')}")
    if g1.get("engine") == "edge":
        wav = proj_path / g1["wav"]
        check("tts.generate wav exists", wav.is_file() and wav.stat().st_size > 10_000, str(g1["wav"]))
        check("tts.generate words file", g1.get("words") and (proj_path / g1["words"]).is_file(), str(g1.get("words")))
        check("tts.generate words count", g1.get("words_count", 0) >= 10, f"count={g1.get('words_count')}")
        check("tts.generate duration sane", 2.0 < g1.get("duration_s", 0) < 60.0, f"dur={g1.get('duration_s')}")
        words = json.loads((proj_path / g1["words"]).read_text(encoding="utf-8"))
        check("tts.generate word shape", all("word" in w and "start_s" in w and "dur_s" in w for w in words[:5]), "bad word rows")
        check("tts.generate words ordered", all(words[i]["start_s"] <= words[i + 1]["start_s"] for i in range(len(words) - 1)), "not sorted")
        last_end = words[-1]["start_s"] + words[-1]["dur_s"]
        check("tts.generate words fit audio", last_end <= g1["duration_s"] + 0.75, f"last_end={last_end} dur={g1['duration_s']}")
        # cache hit: identical call must be flagged cached and skip the network
        g2 = request(
            "tts.generate",
            {"project_path": str(proj_path), "text": TEXT, "voice": "en-US-AndrewMultilingualNeural", "rate_pct": 0, "out_name": "hook2"},
            timeout=60,
        )
        check("tts.generate cache hit", g2.get("cached") is True, f"cached={g2.get('cached')}")
        check("tts.generate cache same key", g1.get("cache_key") == g2.get("cache_key"))
except Exception as exc:
    softcheck("tts.generate edge flow", False, f"{type(exc).__name__}: {exc}")

# tts.preview — writes into studio/preview/
try:
    p1 = request(
        "tts.preview",
        {"project_path": str(proj_path), "text": "A short voice preview.", "voice": "en-US-AvaMultilingualNeural"},
        timeout=180,
    )
    wav_rel = str(p1.get("wav", "")).replace("\\", "/")
    check("tts.preview path", wav_rel.startswith("studio/preview/") and (proj_path / p1["wav"]).is_file(), str(p1.get("wav")))
except Exception as exc:
    softcheck("tts.preview", False, f"{type(exc).__name__}: {exc}")

# dwk.validate_srt over RPC
try:
    rep = request("dwk.validate_srt", {"srt_path": str(good_srt)}, timeout=30)
    check("rpc validate_srt good", rep.get("valid") is True and rep.get("cue_count") == 2, json.dumps(rep)[:150])
    rep = request("dwk.validate_srt", {"srt_path": str(bad_srt)}, timeout=30)
    check("rpc validate_srt bad", rep.get("valid") is False, "bad srt passed validation")
except Exception as exc:
    check("rpc validate_srt", False, f"{type(exc).__name__}: {exc}")

proc.stdin.close()
try:
    proc.wait(timeout=15)
except subprocess.TimeoutExpired:
    proc.kill()

print()
if warn_only:
    print(f"warn-only (live network): {len(warn_only)}")
    for w in warn_only:
        print(f"  ~ {w}")
if failures:
    print(f"FAILED: {len(failures)}")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)
print("TTS bridge tests: PASS")
sys.exit(0)
