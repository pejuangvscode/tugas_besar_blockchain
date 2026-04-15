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


app = FastAPI(
    title="Sovereign Medical Records API",
    version="1.0.0",
    description="FastAPI backend for encrypted medical record anchoring and integrity verification.",
)

frontend_origin = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[frontend_origin, "http://127.0.0.1:5173"],
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
