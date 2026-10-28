"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [["/analyze", "Analyze"], ["/data", "Data & model"]] as const;

export default function NavLinks() {
  const path = usePathname();
  return (
    <nav className="links">
      {LINKS.map(([href, label]) => <Link key={href} href={href} aria-current={path === href ? "page" : undefined}>{label}</Link>)}
    </nav>
  );
}
