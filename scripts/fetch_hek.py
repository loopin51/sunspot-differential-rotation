#!/usr/bin/env python3
"""Fetch NOAA active-region positions from HEK, chunked by week to avoid timeouts.

Window: 2026-05-29 +/- 2 months  ->  2026-03-29 .. 2026-07-29
Keeps Stonyhurst (hgs_*) and Carrington (hgc_*) heliographic coords + obs time.
"""
import json, time, sys
import urllib.request, urllib.parse
from datetime import datetime, timedelta
import pandas as pd

BASE = "https://www.lmsal.com/hek/her"
START = datetime(2026, 3, 29)
END   = datetime(2026, 7, 29)
STEP  = timedelta(days=7)

def query(t0, t1, page):
    params = {
        "cmd": "search", "type": "column", "event_type": "AR",
        "event_starttime": t0.strftime("%Y-%m-%dT%H:%M:%S"),
        "event_endtime":   t1.strftime("%Y-%m-%dT%H:%M:%S"),
        "event_coordsys": "helioprojective",
        "x1": -1400, "x2": 1400, "y1": -1400, "y2": 1400,
        "result_limit": 200, "page": page,
        "return": "frm_name,ar_noaanum,hgs_x,hgs_y,hgc_x,hgc_y,"
                  "event_starttime,event_endtime,SOL_standard",
        "cosec": 2,
    }
    url = BASE + "?" + urllib.parse.urlencode(params)
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            wait = 2 ** attempt
            print(f"  [{t0:%m-%d}] page {page} attempt {attempt} failed: {e}; retry {wait}s",
                  file=sys.stderr, flush=True)
            time.sleep(wait)
    raise RuntimeError(f"chunk {t0:%m-%d} page {page} failed")

rows = []
t = START
while t < END:
    t1 = min(t + STEP, END)
    page = 1
    while True:
        data = query(t, t1, page)
        res = data.get("result", [])
        if not res:
            break
        rows.extend(res)
        print(f"[{t:%Y-%m-%d}..{t1:%m-%d}] page {page}: +{len(res)} (total {len(rows)})",
              file=sys.stderr, flush=True)
        if len(res) < 200:
            break
        page += 1
        time.sleep(0.3)
    t = t1
    time.sleep(0.3)

df = pd.DataFrame(rows)
print("Raw rows:", len(df), "cols:", list(df.columns), file=sys.stderr, flush=True)
df.to_csv("/home/claude/solar/hek_raw.csv", index=False)

df_noaa = df[df["ar_noaanum"].notna()].copy()
df_noaa["ar_noaanum"] = df_noaa["ar_noaanum"].astype(int)
print("Rows w/ NOAA:", len(df_noaa), file=sys.stderr, flush=True)
print("Distinct NOAA:", sorted(df_noaa["ar_noaanum"].unique()), file=sys.stderr, flush=True)
print("frm_name counts:\n", df_noaa["frm_name"].value_counts(), file=sys.stderr, flush=True)
df_noaa.to_csv("/home/claude/solar/hek_noaa.csv", index=False)
print("SAVED", file=sys.stderr, flush=True)
