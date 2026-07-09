#!/usr/bin/env python3
"""태양 차등회전 대시보드 로컬 서버 + HEK 프록시.

사용법:  python3 serve.py   →  http://localhost:8899

HEK 서버(lmsal.com)는 브라우저의 교차출처(Origin 포함) 요청을 403으로 차단하므로,
이 서버가 /hek 요청을 서버측에서 대신 전달합니다. 표준 라이브러리만 사용합니다.
"""
import http.server
import urllib.request
import urllib.parse
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
HEK = "https://www.lmsal.com/hek/her"


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/hek?"):
            return self.proxy_hek()
        if self.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def proxy_hek(self):
        qs = self.path.split("?", 1)[1]
        url = HEK + "?" + qs
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "solar-rotation-dashboard/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            msg = str(e).encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def log_message(self, fmt, *args):
        sys.stderr.write("  " + (fmt % args) + "\n")


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    print(f"태양 차등회전 대시보드: http://localhost:{PORT}")
    print("종료: Ctrl+C")
    ThreadingServer(("", PORT), Handler).serve_forever()
