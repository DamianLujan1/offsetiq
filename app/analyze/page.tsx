import { Suspense } from "react";
import Analyzer from "@/components/Analyzer";

export const metadata = { title: "Analyze · OffsetIQ" };

export default function Page() {
  return <Suspense fallback={<div className="wrap mut">Loading…</div>}><Analyzer /></Suspense>;
}
