#!/usr/bin/env python3
"""Solar differential rotation from HEK active-region tracks.

Method
------
Carrington longitude rotates with the Sun at the fixed sidereal Carrington rate
  Omega_C = 14.1844 deg/day  (sidereal period 25.38 d).
A feature at latitude phi rotating at the local sidereal rate Omega(phi) has a
Carrington longitude that drifts at  dL_C/dt = Omega(phi) - Omega_C.
So per active region we fit L_C(t) (unwrapped) vs time -> slope ->
  Omega_sid(phi) = 14.1844 + slope.
Then fit the classic profile  Omega(phi) = A + B sin^2(phi) (+ C sin^4(phi)).
"""
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
import seaborn as sns

# Register a Korean-capable font so Hangul labels render cleanly
_kf = "/usr/share/fonts/truetype/nanum/NanumBarunGothic.ttf"
try:
    fm.fontManager.addfont(_kf)
    plt.rcParams["font.family"] = fm.FontProperties(fname=_kf).get_name()
except Exception as e:
    print("font register failed:", e)
plt.rcParams["axes.unicode_minus"] = False

OMEGA_CARR = 14.1844  # deg/day, sidereal Carrington rotation rate
# ARs actually shown on the Helioviewer screenshot (11 markers; 14450 & 14451 absent)
SCREEN_NOAA = [14443, 14444, 14445, 14446, 14447, 14448, 14449, 14452, 14453, 14454, 14455]

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

# Use ALL detections (HMI SHARP + NOAA SWPC Observer) so screen ARs that are
# only reported by one source are still covered. Median aggregation makes the
# daily position robust to SHARP fragments mapped to the same NOAA number.
print("Detection sources:\n", df["frm_name"].value_counts(), "\n")

# Restrict to on-disk, away from the limb to limit projection error.
dfx = df[df["stony_lon"].abs() <= 60].copy()

# ---- Daily aggregation per AR (organised lat/lon table, robust median) ----
dfx["date"] = dfx["t"].dt.floor("D")
daily = (dfx.groupby(["ar_noaanum", "date"])
            .agg(stony_lon=("stony_lon", "median"),
                 lat=("lat", "median"),
                 carr_lon=("carr_lon", "median"),
                 carr_lat=("carr_lat", "median"),
                 n=("lat", "size"))
            .reset_index()
            .sort_values(["ar_noaanum", "date"]))
daily.to_csv("/home/claude/solar/ar_daily_positions.csv", index=False)
print(f"Daily positions saved: {len(daily)} rows, "
      f"{daily['ar_noaanum'].nunique()} active regions\n")

# ---- Per-AR rotation-rate fit ----
recs = []
t0 = daily["date"].min()
for ar, g in daily.groupby("ar_noaanum"):
    g = g.sort_values("date")
    if len(g) < 3:
        continue
    days = (g["date"] - t0).dt.total_seconds().values / 86400.0
    span = days.max() - days.min()
    if span < 2.0:  # need a real time baseline
        continue
    # unwrap Carrington longitude (deg) to remove 360 wraps
    lon_un = np.degrees(np.unwrap(np.radians(g["carr_lon"].values)))
    A = np.vstack([days, np.ones_like(days)]).T
    slope, intercept = np.linalg.lstsq(A, lon_un, rcond=None)[0]
    resid = lon_un - (slope * days + intercept)
    rms = float(np.sqrt(np.mean(resid**2)))
    mean_lat = float(g["lat"].mean())
    omega_sid = OMEGA_CARR + slope
    recs.append(dict(ar_noaanum=int(ar), mean_lat=mean_lat,
                     n_days=len(g), span_days=round(span, 1),
                     slope_degday=round(slope, 4),
                     omega_sid_degday=round(omega_sid, 4),
                     fit_rms_deg=round(rms, 3),
                     on_screen=int(ar) in SCREEN_NOAA))

rot_all = pd.DataFrame(recs).sort_values("mean_lat")
rot_all.to_csv("/home/claude/solar/ar_rotation_rates.csv", index=False)
print("Per-AR rotation rates (all):\n", rot_all.to_string(index=False), "\n")

# ---- Quality cut for the profile fit -------------------------------------
# Reject tracks whose linear fit is poor (bad detections / longitude-unwrap
# failures / merged-region reuse) and short baselines. No rotation-rate range
# cut — poor fits are already handled by the RMS threshold.
GOOD = (rot_all["fit_rms_deg"] <= 1.0) & (rot_all["n_days"] >= 5) \
       & (rot_all["span_days"] >= 5)
rot = rot_all[GOOD].copy()
dropped = rot_all[~GOOD]
print(f"Quality cut: kept {len(rot)}/{len(rot_all)} AR tracks. "
      f"Dropped: {sorted(dropped['ar_noaanum'].tolist())}\n")

# ---- Differential-rotation profile fit  Omega = A + B sin^2(phi) ----
phi = np.radians(rot["mean_lat"].values)
omega = rot["omega_sid_degday"].values
s2 = np.sin(phi)**2
s4 = np.sin(phi)**4

# Weight long, clean tracks more (inverse variance ~ span / rms)
w = rot["span_days"].values / (rot["fit_rms_deg"].values + 0.1)
W = np.sqrt(w)

# 2-term weighted fit
M2 = np.vstack([np.ones_like(s2), s2]).T
coef2 = np.linalg.lstsq(M2 * W[:, None], omega * W, rcond=None)[0]
A2, B2 = float(coef2[0]), float(coef2[1])
# 3-term fit (only if enough points)
if len(rot) >= 6:
    M3 = np.vstack([np.ones_like(s2), s2, s4]).T
    coef3 = np.linalg.lstsq(M3 * W[:, None], omega * W, rcond=None)[0]
    A3, B3, C3 = map(float, coef3)
else:
    A3 = B3 = C3 = np.nan

pred2 = A2 + B2*s2
ss_res = np.sum((omega - pred2)**2)
ss_tot = np.sum((omega - omega.mean())**2)
r2 = 1 - ss_res/ss_tot if ss_tot > 0 else float("nan")
rms_fit = np.sqrt(np.mean((omega - pred2)**2))
print(f"2-term fit:  Omega = {A2:.3f} + ({B2:.3f}) sin^2(phi)   "
      f"R^2={r2:.3f}  RMS={rms_fit:.3f} deg/day  (N={len(rot)})")
if not np.isnan(A3):
    print(f"3-term fit:  Omega = {A3:.3f} + ({B3:.3f}) sin^2 + ({C3:.3f}) sin^4")
# Literature (Snodgrass & Ulrich 1990, sidereal, spectroscopic):
#   A=14.71, B=-2.39, C=-1.78
print("\nSnodgrass&Ulrich 1990 (sidereal): 14.71 - 2.39 sin^2 - 1.78 sin^4")

# ---- Plot ----
sns.set_theme(style="whitegrid", context="talk")
plt.rcParams["font.family"] = fm.FontProperties(fname=_kf).get_name()
plt.rcParams["axes.unicode_minus"] = False
fig, ax = plt.subplots(figsize=(12, 7.5))
lat_grid = np.linspace(-40, 40, 400)
sg = np.radians(lat_grid)

# Reference profile (Snodgrass & Ulrich 1990, sidereal)
snod = 14.71 - 2.39*np.sin(sg)**2 - 1.78*np.sin(sg)**4
ax.plot(lat_grid, snod, "--", color="0.45", lw=2,
        label="Snodgrass & Ulrich 1990 (문헌값, sidereal)")

# Our fits
fit2 = A2 + B2*np.sin(sg)**2
ax.plot(lat_grid, fit2, "-", color="#c0392b", lw=2.6,
        label=fr"2항 피팅:  $\Omega={A2:.2f}{B2:+.2f}\,\sin^2\phi$  ($R^2$={r2:.2f})")
if not np.isnan(A3):
    fit3 = A3 + B3*np.sin(sg)**2 + C3*np.sin(sg)**4
    ax.plot(lat_grid, fit3, ":", color="#8e44ad", lw=2.2,
            label=fr"3항 피팅:  $\Omega={A3:.2f}{B3:+.2f}\sin^2{C3:+.2f}\sin^4\phi$")

# Data points: size ~ track weight (baseline / rms)
sizes = 60 + 380 * (w - w.min()) / (w.max() - w.min() + 1e-9)
for on, color, lab in [(True, "#e74c3c", "화면 표시 AR (Helioviewer 11개)"),
                       (False, "#2c7fb8", "기타 AR")]:
    m = rot["on_screen"] == on
    ax.scatter(rot.loc[m, "mean_lat"], rot.loc[m, "omega_sid_degday"],
               s=sizes[m.values], c=color, edgecolor="white",
               linewidth=1.4, zorder=5, alpha=0.9, label=lab)
# Label only the on-screen active regions, spread out with leader lines
offsets = {14444: (-70, -34), 14443: (-58, 30), 14447: (18, -42),
           14449: (10, 24), 14445: (0, 26), 14446: (0, -30),
           14454: (40, 20), 14455: (30, 22)}
for _, r in rot[rot["on_screen"]].iterrows():
    dx, dy = offsets.get(int(r["ar_noaanum"]), (0, 14))
    ax.annotate(f"NOAA {int(r['ar_noaanum'])}",
                (r["mean_lat"], r["omega_sid_degday"]),
                textcoords="offset points", xytext=(dx, dy),
                ha="center", fontsize=9.5, fontweight="bold", color="#c0392b",
                arrowprops=dict(arrowstyle="-", color="#c0392b", lw=0.8))

ax.legend(loc="lower center", fontsize=11, frameon=True, ncol=1)
ax.set_xlabel("태양 위도  φ  (deg)")
ax.set_ylabel("항성 회전 각속도  Ω  (deg/day)")
ax.set_title("흑점 추적으로 본 태양의 차등회전 (Differential Rotation)\n"
             "HEK 활성영역 · 2026-03-29 ~ 2026-07-29 · 점 크기 = 추적 신뢰도",
             fontsize=14)
ax.set_xlim(-40, 40)
ax.set_ylim(12.3, 15.2)
fig.tight_layout()
fig.savefig("/home/claude/solar/differential_rotation.png", dpi=150)
print("\nSaved plot -> differential_rotation.png")
