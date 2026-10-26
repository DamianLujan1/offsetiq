import { NextResponse } from "next/server";

// DEMO auth: no passwords, no email is sent. A cookie stores the entered email so the UI can
// show a signed-in state. Replace with a real provider (e.g. Clerk/Auth.js) before production use.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "Enter a valid email" }, { status: 400 });
  const res = NextResponse.json({ ok: true, email, demo: true });
  res.cookies.set("oiq_demo_user", email, { path: "/", maxAge: 60 * 60 * 24 * 7, sameSite: "lax", secure: true });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("oiq_demo_user", "", { path: "/", maxAge: 0 });
  return res;
}
