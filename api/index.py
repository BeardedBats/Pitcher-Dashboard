"""Vercel serverless entry point.

Wraps the existing FastAPI app with Mangum so it runs as a
serverless function on Vercel's Python runtime.
"""
import sys
import os

# Make the backend package importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app import app  # noqa: E402
from mangum import Mangum  # noqa: E402

handler = Mangum(app, lifespan="off")
