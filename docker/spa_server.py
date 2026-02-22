#!/usr/bin/env python3
import argparse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote, urlparse


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Static server with SPA fallback")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--directory", default=".")
    return parser.parse_args()


class SPAHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str, **kwargs):
        self._root = Path(directory).resolve()
        super().__init__(*args, directory=directory, **kwargs)

    def _resolve_request_path(self) -> Path:
        request_path = unquote(urlparse(self.path).path)
        candidate = (self._root / request_path.lstrip("/")).resolve()
        if self._root in candidate.parents or candidate == self._root:
            return candidate
        return self._root

    def _should_fallback_to_index(self) -> bool:
        request_path = unquote(urlparse(self.path).path)
        candidate = self._resolve_request_path()
        if candidate.is_file():
            return False
        if request_path in ("", "/"):
            return True
        return "." not in Path(request_path).name

    def do_GET(self) -> None:
        if self._should_fallback_to_index():
            self.path = "/index.html"
        super().do_GET()

    def do_HEAD(self) -> None:
        if self._should_fallback_to_index():
            self.path = "/index.html"
        super().do_HEAD()


def main() -> None:
    args = parse_args()
    directory = str(Path(args.directory).resolve())

    def handler(*handler_args, **handler_kwargs):
        return SPAHandler(*handler_args, directory=directory, **handler_kwargs)

    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
