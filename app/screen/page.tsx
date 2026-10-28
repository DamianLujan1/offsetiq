import { Suspense } from "react";
import ScreenAgent from "@/components/ScreenAgent";

export const metadata = { title: "Screen · OffsetIQ" };

export default function Page() {
  return <Suspense fallback={<div className="wrap mut">Loading…</div>}><ScreenAgent /></Suspense>;
}
