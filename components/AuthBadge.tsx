"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

export function readDemoUser(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|; )oiq_demo_user=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function AuthBadge() {
  const [u, setU] = useState<string | null>(null);
  useEffect(() => setU(readDemoUser()), []);
  if (!u) return <Link href="/login" className="btn sm ghost">Sign in</Link>;
  return (
    <span className="small mut">
      {u} ·{" "}
      <a href="#" onClick={async (e) => { e.preventDefault(); await fetch("/api/auth", { method: "DELETE" }); location.reload(); }}>sign out</a>
    </span>
  );
}
