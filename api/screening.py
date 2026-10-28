"""Vercel Function: the screening agent, deployed with the app.

next.config.ts routes /api/agent/* here, and agent/server.py serves those paths, so the browser
calls the agent on the app's own origin. Off Vercel, run `python3 -m agent.server` instead.
"""
from agent.server import app  # noqa: F401  (Vercel serves the ASGI app named `app`)
