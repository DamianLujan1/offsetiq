"use client";
import { useState } from "react";

export default function Login() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  async function go(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    const j = await r.json();
    if (j.ok) { window.location.href = "/analyze"; } else setMsg(j.error ?? "Error");
  }
  return (
    <main><div className="wrap" style={{ maxWidth: 460 }}>
      <h1>Sign in <span className="pill">demo</span></h1>
      <p className="mut small">Demo authentication: enter any work email to create a session cookie. No email is sent and no password is stored. Production would use a magic-link / SSO provider.</p>
      <form className="card" onSubmit={go}>
        <input type="email" required placeholder="you@operator.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />
        <button className="btn" type="submit">Continue</button>
        {msg && <div className="warn" style={{ marginTop: 10 }}>{msg}</div>}
      </form>
    </div></main>
  );
}
