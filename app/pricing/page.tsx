"use client";
import { useState } from "react";

const SEAT = 499;

export default function Pricing() {
  const [seats, setSeats] = useState(3);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function checkout() {
    setBusy(true); setMsg("");
    const r = await fetch("/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seats }) });
    const j = await r.json(); setBusy(false);
    if (j.url) window.location.href = j.url; else setMsg(j.message ?? j.error ?? "Error");
  }
  return (
    <main><div className="wrap" style={{ maxWidth: 900 }}>
      <h1>Pricing <span className="pill">demo</span></h1>
      <p className="mut">Simple per-seat pricing for operator engineering, land and A&amp;D teams. Billing below is a Stripe test-mode stub: nothing is charged.</p>
      <div className="grid g3">
        <div className="card"><h3>Pilot</h3><div className="v" style={{ fontSize: 28, fontWeight: 700 }}>$0</div><div className="mut small">30 days · 3 seats · all counties · CSV/PDF export</div></div>
        <div className="card" style={{ borderColor: "var(--acc)" }}><h3>Team</h3><div style={{ fontSize: 28, fontWeight: 700 }}>${SEAT}<span className="mut small">/seat/mo</span></div><div className="mut small">Unlimited offset reports · backtests · API access · shareable links</div></div>
        <div className="card"><h3>Enterprise</h3><div style={{ fontSize: 28, fontWeight: 700 }}>Talk to us</div><div className="mut small">Your own well data blended with RRC offsets · SSO · more basins</div></div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Team seats</h3>
        <div className="row" style={{ alignItems: "center", gap: 12 }}>
          <input type="range" min={1} max={25} value={seats} onChange={(e) => setSeats(Number(e.target.value))} />
          <b>{seats} seat{seats > 1 ? "s" : ""}</b><span className="mut">= ${(seats * SEAT).toLocaleString()}/month</span>
          <button className="btn" disabled={busy} onClick={checkout}>{busy ? "…" : "Start subscription (demo)"}</button>
        </div>
        {msg && <div className="warn" style={{ marginTop: 10 }}>{msg}</div>}
      </div>
    </div></main>
  );
}
