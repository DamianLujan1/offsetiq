import { NextResponse } from "next/server";

export const SEAT_PRICE_USD = 499;

// Stripe stub. If STRIPE_SECRET_KEY + STRIPE_PRICE_ID are set (test-mode keys), a real Stripe
// Checkout Session (subscription, quantity = seats) is created via the REST API. Otherwise a demo
// response is returned and no payment is attempted.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const seats = Math.max(1, Math.min(500, Math.floor(Number(body.seats) || 1)));
  const key = process.env.STRIPE_SECRET_KEY, price = process.env.STRIPE_PRICE_ID;
  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
  if (!key || !price || key.includes("REPLACE_ME")) {
    return NextResponse.json({ demo: true, seats, monthly_usd: seats * SEAT_PRICE_USD,
      message: "Demo mode: Stripe keys are not configured, so no checkout was created and nothing was charged." });
  }
  const form = new URLSearchParams({
    mode: "subscription", "line_items[0][price]": price, "line_items[0][quantity]": String(seats),
    success_url: `${origin}/pricing?status=success`, cancel_url: `${origin}/pricing?status=cancel`,
  });
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form,
  });
  const j = await r.json();
  if (!r.ok) return NextResponse.json({ error: j?.error?.message ?? "Stripe error" }, { status: 502 });
  return NextResponse.json({ url: j.url, seats });
}
