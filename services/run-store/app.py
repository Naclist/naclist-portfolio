from __future__ import annotations

import asyncio
import gzip
import json
import os
import re
import secrets
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware

RETENTION_SECONDS = int(os.getenv("RUN_STORE_RETENTION_SECONDS", "86400"))
MAX_UPLOAD_BYTES = int(os.getenv("RUN_STORE_MAX_UPLOAD_BYTES", str(2 * 1024 * 1024)))
MAX_STORE_BYTES = int(os.getenv("RUN_STORE_MAX_STORE_BYTES", str(256 * 1024 * 1024)))
MAX_FILES = int(os.getenv("RUN_STORE_MAX_FILES", "200"))
UPLOADS_PER_HOUR = int(os.getenv("RUN_STORE_UPLOADS_PER_HOUR", "30"))
STORE = Path(os.getenv("RUN_STORE_DIR", "/home/naclist/synthetic-city-run-store/data"))
TOKEN = re.compile(r"^[A-Za-z0-9_-]{12,40}$")
UPLOAD_HISTORY: dict[str, deque[float]] = defaultdict(deque)
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "RUN_STORE_ORIGINS",
        "https://naclist.github.io,http://127.0.0.1:8766,http://localhost:1313",
    ).split(",")
    if origin.strip()
]


def cleanup() -> None:
    STORE.mkdir(parents=True, exist_ok=True)
    now = time.time()
    files = sorted(STORE.glob("*.json.gz"), key=lambda path: path.stat().st_mtime)
    for path in files:
        if now - path.stat().st_mtime > RETENTION_SECONDS:
            path.unlink(missing_ok=True)
    files = sorted(STORE.glob("*.json.gz"), key=lambda path: path.stat().st_mtime)
    total = sum(path.stat().st_size for path in files)
    while files and (len(files) >= MAX_FILES or total >= MAX_STORE_BYTES):
        oldest = files.pop(0)
        total -= oldest.stat().st_size
        oldest.unlink(missing_ok=True)


async def cleanup_loop() -> None:
    while True:
        await asyncio.sleep(900)
        cleanup()


@asynccontextmanager
async def lifespan(_: FastAPI):
    cleanup()
    task = asyncio.create_task(cleanup_loop())
    yield
    task.cancel()


app = FastAPI(title="Synthetic City 24-hour Run Store", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
    max_age=86400,
)


@app.get("/health")
def health() -> dict[str, int | str]:
    cleanup()
    files = list(STORE.glob("*.json.gz"))
    return {
        "status": "ok",
        "retention_seconds": RETENTION_SECONDS,
        "stored_runs": len(files),
        "stored_bytes": sum(path.stat().st_size for path in files),
        "max_store_bytes": MAX_STORE_BYTES,
    }


@app.post("/runs", status_code=201)
async def create_run(request: Request) -> dict[str, int | str]:
    now = time.time()
    client = request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")
    history = UPLOAD_HISTORY[client]
    while history and now - history[0] > 3600:
        history.popleft()
    if len(history) >= UPLOADS_PER_HOUR:
        raise HTTPException(429, "Upload rate limit reached; try again later")
    declared = int(request.headers.get("content-length", "0") or 0)
    if declared > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Run JSON exceeds the 2 MiB upload limit")
    raw = await request.body()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Run JSON exceeds the 2 MiB upload limit")
    try:
        document = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(400, "Invalid JSON") from error
    if document.get("schema") != "synthetic-city-epidemic-run-v1":
        raise HTTPException(422, "Unsupported run schema")
    if int(document.get("population", 0)) != 10_000:
        raise HTTPException(422, "The public run store accepts the 10K model only")
    cleanup()
    token = secrets.token_urlsafe(12)
    target = STORE / f"{token}.json.gz"
    temporary = STORE / f".{token}.tmp"
    with gzip.open(temporary, "wb", compresslevel=6) as handle:
        handle.write(json.dumps(document, separators=(",", ":")).encode("utf-8"))
    temporary.replace(target)
    history.append(now)
    return {"id": token, "expires_in": RETENTION_SECONDS, "size_bytes": target.stat().st_size}


@app.get("/runs/{run_id}")
def read_run(run_id: str) -> Response:
    if not TOKEN.fullmatch(run_id):
        raise HTTPException(404, "Run not found")
    target = STORE / f"{run_id}.json.gz"
    if not target.exists() or time.time() - target.stat().st_mtime > RETENTION_SECONDS:
        target.unlink(missing_ok=True)
        raise HTTPException(404, "Run expired or not found")
    with gzip.open(target, "rb") as handle:
        payload = handle.read()
    remaining = max(0, int(RETENTION_SECONDS - (time.time() - target.stat().st_mtime)))
    return Response(
        payload,
        media_type="application/json",
        headers={"Cache-Control": "private, max-age=60", "X-Run-Expires-In": str(remaining)},
    )
