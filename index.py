"""Vercel entry point – exposes the FastAPI app for native Python support."""
import sys
import os

# Allow imports from backend/ (data.py, aggregation.py, redis_cache.py, etc.)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

from app import app  # noqa: E402, F401
