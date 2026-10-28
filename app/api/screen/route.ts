import { NextResponse } from "next/server";

// POST /api/screen -> the Python screening agent (agent/server.py), streamed back unchanged as
// NDJSON events. OFFSETIQ_AGENT_TOKEN, when set, is sent as a bearer token so only this route can
// run screens on the agent. Nothing here logs or stores the prompt, the drawn areas or the results.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY = 256_000;

function agentUrl(): string | null {
  const u = process.env.OFFSETIQ_AGENT_URL;
  if (u) return u.replace(/\/+$/, "");
  return process.env.NODE_ENV === "development" ? "http://127.0.0.1:8765" : null;
}

export async function POST(req: Request) {
  const base = agentUrl();
  if (!base) {
    return NextResponse.json({ error: "Screen mode is not connected on this deployment: set OFFSETIQ_AGENT_URL to the screening agent service (python -m agent.server). The Analyze page works without it." }, { status: 503 });
  }
  const body = await req.text();
  if (body.length > MAX_BODY) return NextResponse.json({ error: "Request too large: draw fewer or simpler shapes." }, { status: 413 });
  let upstream: Response;
  try {
    const token = process.env.OFFSETIQ_AGENT_TOKEN;
    upstream = await fetch(`${base}/screen`, {
      method: "POST", body, cache: "no-store", signal: req.signal, redirect: "manual",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  } catch {
    const where = process.env.NODE_ENV === "development" ? ` at ${base}. Start it with: python3 -m agent.server` : ".";
    return NextResponse.json({ error: `The screening agent is not reachable${where}` }, { status: 503 });
  }
  // 401 is the agent's token check, or deployment protection in front of a non-production agent URL
  // (which may also answer with a redirect to a login page).
  if (upstream.status === 401 || (upstream.status >= 300 && upstream.status < 400)) {
    return NextResponse.json({ error: `The screening agent did not accept this request (HTTP ${upstream.status}): OFFSETIQ_AGENT_TOKEN must be the same on the app and the agent, and OFFSETIQ_AGENT_URL must be the agent's public production domain, not a protected deployment URL.` }, { status: 502 });
  }
  if (upstream.status === 422) {
    return NextResponse.json({ error: "The request was not understood: the prompt must be 1-2,000 characters and each drawn tract needs at least 3 corners." }, { status: 400 });
  }
  const type = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !upstream.body || !type.startsWith("application/x-ndjson")) {
    const what = upstream.ok ? `answered with ${type || "no content type"} instead of its event stream: check OFFSETIQ_AGENT_URL` : `returned an error (${upstream.status})`;
    return NextResponse.json({ error: `The screening agent ${what}.` }, { status: 502 });
  }
  return new Response(upstream.body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
