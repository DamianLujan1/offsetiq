"""Vercel build step for the agent project: copy the public-data snapshot next to the code.

Vercel serves public/ from its CDN and leaves it out of a Python function's bundle, so
pyproject.toml runs `python -m agent.bundle` after installing dependencies. It copies the same
public files the Analyze page reads, nothing else. Standard library only.
"""
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public", "data")
BUNDLED = os.path.join(ROOT, "agent", "_snapshot")   # build output, git-ignored
FILES = ("wells.json", "horizontals.json", "model.json", "meta.json")   # all the agent reads


def data_dir() -> str:
    """OFFSETIQ_DATA_DIR, else public/data (local runs and tests), else the bundled copy (Vercel)."""
    return os.environ.get("OFFSETIQ_DATA_DIR") or (PUBLIC if os.path.isdir(PUBLIC) else BUNDLED)


def main(dst: str = BUNDLED) -> None:
    os.makedirs(dst, exist_ok=True)
    for f in FILES:
        shutil.copyfile(os.path.join(PUBLIC, f), os.path.join(dst, f))
    print(f"Copied {len(FILES)} snapshot files from public/data to {os.path.relpath(dst, ROOT)}")


if __name__ == "__main__":
    main()
