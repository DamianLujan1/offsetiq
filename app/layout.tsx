import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import Link from "next/link";
import NavLinks from "@/components/NavLinks";
import "./globals.css";

const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "OffsetIQ — Permian offset analysis in seconds",
  description: "Drop a location in Midland, Ector, Andrews or Martin County TX: public offset horizontals, Arps decline/EUR, and a LightGBM forecast trained on Texas RRC data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <header className="nav">
          <Link href="/" className="brand">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 12.5 4.5 1.5M6.25 12.5l2.5-11M10.5 12.5 13 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            OffsetIQ
          </Link>
          <NavLinks />
          <span className="sp" />
          <span className="nav-note" title="Demo build on public RRC data">Demo · Texas RRC public data</span>
        </header>
        {children}
      </body>
    </html>
  );
}
