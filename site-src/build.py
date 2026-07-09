#!/usr/bin/env python3
"""Inline data + JS into index.html -> single-file dashboard."""
import json, pathlib

d = pathlib.Path(__file__).parent
html = (d / "index.html").read_text()
data = (pathlib.Path("/home/claude/solar/embedded_data.json")).read_text()
analysis = (d / "analysis.js").read_text()
# strip the node export line for browser inlining
analysis = analysis.replace(
    'if (typeof module !== "undefined") module.exports = { aggregateDaily, fitTracks, fitProfile, unwrapDeg, median, OMEGA_C };', "")
app = (d / "app.js").read_text()
for token, repl in [("__EMBEDDED_DATA__", data), ("__ANALYSIS_JS__", analysis), ("__APP_JS__", app)]:
    assert token in html, token
    html = html.replace(token, repl)
assert "</script>" not in data
out = d / "dist" / "index.html"
out.parent.mkdir(exist_ok=True)
out.write_text(html)
print("built", out, len(html), "bytes")
