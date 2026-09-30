"""Entrypoint for the visual grounding viewer backend.

Run with:
    uvicorn app:app --reload --port 8011
"""

from __future__ import annotations

from pathlib import Path

from fastapi import Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.app import app

_FRONTEND_DIST = Path(__file__).parent / "frontend" / "dist"
_ASSETS_DIR = _FRONTEND_DIST / "assets"
_FRONTEND_PUBLIC_STATIC = Path(__file__).parent / "frontend" / "public" / "static"
_STATIC_DIR = _FRONTEND_DIST / "static"

if _ASSETS_DIR.exists():
    app.mount("/assets", StaticFiles(directory=_ASSETS_DIR), name="assets")

if not _STATIC_DIR.exists():
    _STATIC_DIR = _FRONTEND_PUBLIC_STATIC

if _STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


@app.get("/", response_model=None)
def root() -> Response:
    index_file = _FRONTEND_DIST / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return JSONResponse({"message": "Frontend not built yet. Run npm install && npm run build in frontend/."})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8011)
