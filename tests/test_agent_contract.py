"""The proposal the Python agent emits is the contract the browser codes against.

tests/fixtures/proposal_tracts.json is a real proposal from agent/loop.py. The TS
side (scripts/screen-hitl.test.ts) builds the approved report, CSV and share link
from it; this test fails if the fixture no longer matches what the loop emits, so
the two halves cannot drift apart silently. Regenerate with:
    python -m tests.test_agent_contract
"""
import asyncio
import json
import os

from agent.loop import run

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "proposal_tracts.json")
PROMPT = "compare these two tracts, top 6, csv"
CONTEXT = {"polygons": [
    {"label": "North", "ring": [[31.90, -102.10], [31.90, -102.08], [31.915, -102.08], [31.915, -102.10]]},
    {"label": "South", "ring": [[31.80, -102.00], [31.80, -101.98], [31.815, -101.98], [31.815, -102.00]]},
]}
VOLATILE = ("ms", "screen_ms", "workers")  # timing and machine-dependent


def current() -> dict:
    async def go():
        return [ev async for ev in run(PROMPT, CONTEXT, workers=0)]
    p = asyncio.run(go())[-1]
    for k in VOLATILE:
        p["run"].pop(k, None)
    return json.loads(json.dumps(p))


def test_fixture_is_what_the_agent_emits():
    with open(FIXTURE) as fh:
        assert json.load(fh) == current(), "regenerate: python -m tests.test_agent_contract"


if __name__ == "__main__":
    with open(FIXTURE, "w") as fh:
        json.dump(current(), fh, indent=1)
        fh.write("\n")
    print("wrote", FIXTURE)
