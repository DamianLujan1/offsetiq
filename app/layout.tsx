import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import AuthBadge from "@/components/AuthBadge";

export const metadata: Metadata = {
  title: "OffsetIQ — Permian offset analysis in seconds",
  description: "Drop a location in Midland, Ector, Andrews or Martin County TX: public offset horizontals, Arps decline/EUR, and a LightGBM forecast trained on Texas RRC data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <Link href="/" className="brand">Offset<b>IQ</b></Link>
          <Link href="/analyze" className="l">Analyze</Link>
          <Link href="/data" className="l">Data &amp; model</Link>
          <Link href="/pricing" className="l">Pricing</Link>
          <span className="sp" />
          <span className="pill demo" title="Authentication and billing are demo stubs">DEMO</span>
          <AuthBadge />
        </nav>
        {children}
      </body>
    </html>
  );
}
