#!/usr/bin/env python3
"""Build embedded_data.json for the dashboard.

Unlike the earlier version (which shipped pre-aggregated daily medians over
BOTH detection sources), this embeds the raw per-detection rows tagged with
their source, so the browser can aggregate per user-selected source(s).

Detection sources (srcNames order = src index):
  0 = HMI SHARP
  1 = NOAA SWPC Observer
"""
import json
import pandas as pd
import numpy as np

SCREEN = [14443, 14444, 14445, 14446, 14447, 14448, 14449, 14452, 14453, 14454, 14455]
SRC_NAMES = ["HMI SHARP", "NOAA SWPC Observer"]
SRC_IDX = {name: i for i, name in enumerate(SRC_NAMES)}

df = pd.read_csv("/home/claude/solar/hek_noaa.csv")
df["t"] = pd.to_datetime(df["event_starttime"], utc=True)
df = df.rename(columns={
    "hgs_x": "stony_lon", "hgs_y": "lat",
    "hgc_x": "carr_lon", "hgc_y": "carr_lat",
})
for c in ["stony_lon", "lat", "carr_lon", "carr_lat"]:
    df[c] = pd.to_numeric(df[c], errors="coerce")
df = df.dropna(subset=["carr_lon", "lat", "ar_noaanum"])
df["ar_noaanum"] = df["ar_noaanum"].astype(int)

# only known sources
df = df[df["frm_name"].isin(SRC_NAMES)].copy()

# No near-limb quality cut (user turned it off). Keep only the physically
# visible disk (|Stonyhurst lon| <= 90°); the handful of >90° points are on the
# far side of the Sun and can't be placed on a disk map.
df = df[df["stony_lon"].abs() <= 90].copy()

# minute-resolution timestamp (seconds are all :00); day = ts[:10]
df["ts"] = df["t"].dt.strftime("%Y-%m-%dT%H:%M")

det = []
for _, r in df.iterrows():
    det.append([
        int(r["ar_noaanum"]), r["ts"],
        round(float(r["stony_lon"]), 3), round(float(r["lat"]), 3),
        round(float(r["carr_lon"]), 3), SRC_IDX[r["frm_name"]],
    ])
# stable order: ar, ts, src
det.sort(key=lambda x: (x[0], x[1], x[5]))

out = {
    "generated": "2026-07-12",
    "window": ["2026-03-29", "2026-07-29"],
    "screen": SCREEN,
    "srcNames": SRC_NAMES,
    "detCols": ["ar", "ts", "stonyLon", "lat", "carrLon", "src"],
    "det": det,
}
with open("/home/claude/solar/embedded_data.json", "w") as f:
    json.dump(out, f, separators=(",", ":"), ensure_ascii=False)

print(f"detections embedded: {len(det)}")
print("source counts:", df["frm_name"].value_counts().to_dict())

# ---- verification: reproduce the daily median over BOTH sources ----
def median(a):
    return float(np.median(a))

groups = {}
for d in det:
    ar, ts, s, l, c, src = d
    date = ts[:10]
    groups.setdefault((ar, date), []).append((s, l, c))
daily = []
for (ar, date), vs in groups.items():
    ss = [v[0] for v in vs]; ll = [v[1] for v in vs]; cc = [v[2] for v in vs]
    daily.append([ar, date, median(ss), median(ll), median(cc), len(vs)])
print(f"\n[verify] daily rows (both sources): {len(daily)}  (expected ~548)")
print(f"[verify] distinct ARs: {len({d[0] for d in daily})}")
