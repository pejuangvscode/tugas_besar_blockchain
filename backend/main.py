import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent
load_dotenv(BACKEND_DIR / ".env", override=False)
load_dotenv(ROOT_DIR / ".env", override=False)

from models.database import create_tables
from routes.records import router as records_router
from routes.roles import router as roles_router


app = FastAPI(
    title="Sovereign Medical Records API",
    version="1.0.0",
    description="FastAPI backend for encrypted medical record anchoring and integrity verification.",
)


def _build_allowed_origins() -> list[str]:
    configured = os.getenv("FRONTEND_ORIGIN", "")

    # Support a comma-separated FRONTEND_ORIGIN and keep local dev origins always enabled.
    origins = {
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    }

    if configured:
        for item in configured.split(","):
            origin = item.strip()
            if origin:
                origins.add(origin)

    return sorted(origins)


allowed_origins = _build_allowed_origins()

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup_event() -> None:
    create_tables()


@app.get("/health")
def health_check() -> dict:
    return {"status": "ok"}


app.include_router(records_router, prefix="/records", tags=["records"])
app.include_router(roles_router, prefix="/roles", tags=["roles"])
