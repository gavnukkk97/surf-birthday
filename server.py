#!/usr/bin/env python3
"""Статический сервер проекта с запретом кеширования (чтобы всегда грузился свежий код)."""
import http.server, socketserver, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), NoCache) as httpd:
    print(f'Surf Birthday Route: http://localhost:{PORT} (кеш отключён)')
    httpd.serve_forever()
