"""Rasterize Natural Earth 110m land polygons into a compact dot-map mask.

Input: a public-domain Natural Earth GeoJSON (ne_110m_land).
Output: src/main/producer/world-mask.ts (84 columns × 34 rows, lon -180..180,
lat -60..85). This is a one-off development step; the render itself is offline.
"""
import json
import sys
from pathlib import Path

COLS = 84
ROWS = 34
LON0, LON1 = -180.0, 180.0
LAT0, LAT1 = 85.0, -60.0  # top, bottom (exclude Antarctica)


def rings(geom):
    t = geom.get("type")
    c = geom.get("coordinates")
    if t == "Polygon":
        yield from c
    elif t == "MultiPolygon":
        for poly in c:
            yield from poly


def inside_ring(lon, lat, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def inside_poly(lon, lat, poly):
    if not poly or not inside_ring(lon, lat, poly[0]):
        return False
    for hole in poly[1:]:
        if inside_ring(lon, lat, hole):
            return False
    return True


def main(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    polys = []
    for f in data.get("features", []):
        g = f.get("geometry") or {}
        if g.get("type") == "Polygon":
            polys.append(g["coordinates"])
        elif g.get("type") == "MultiPolygon":
            polys.extend(g["coordinates"])
    rows = []
    for r in range(ROWS):
        lat = LAT0 + (LAT1 - LAT0) * (r + 0.5) / ROWS
        line = []
        for c in range(COLS):
            lon = LON0 + (LON1 - LON0) * (c + 0.5) / COLS
            land = any(inside_poly(lon, lat, p) for p in polys)
            line.append("1" if land else "0")
        rows.append("".join(line))
    # ASCII sanity preview
    for row in rows:
        print("".join("#" if ch == "1" else "." for ch in row))
    out = Path("src/main/producer/world-mask.ts")
    body = "\n".join(f"  '{row}'," for row in rows)
    out.write_text(
        "/**\n"
        " * Dot world map landmask — Natural Earth 110m land (public domain),\n"
        " * rasterized to 84 × 34 cells over lon −180..180 / lat 85..−60.\n"
        " * Generated once from ne_110m_land.geojson; the render is offline.\n"
        " */\n"
        "export const WORLD_MASK = {\n"
        "  cols: 84,\n"
        "  rows: 34,\n"
        "  lon0: -180,\n"
        "  lon1: 180,\n"
        "  lat0: 85,\n"
        "  lat1: -60,\n"
        f"  data: [\n{body}\n  ]\n"
        "} as const\n",
        encoding="utf-8",
    )
    print(f"\nwrote {out} ({COLS}x{ROWS})")


if __name__ == "__main__":
    main(sys.argv[1])