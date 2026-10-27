import { get, list, put } from "@vercel/blob";

export type Signup = { email: string; company: string; role: string; source: string; createdAt: string; updatedAt?: string };

export const ROLES = ["Operator Eng", "Land", "A&D", "Other"] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normalizeEmail = (e: unknown) => (typeof e === "string" ? e.trim().toLowerCase() : "");
export const isValidEmail = (e: string) => e.length > 3 && e.length <= 254 && EMAIL_RE.test(e);
export const clean = (v: unknown, max = 120) => (typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : "");

/** Map raw ?src= / ?utm_source= to a stored source tag. */
export function normalizeSource(raw: unknown): string {
  const s = clean(raw, 60).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  if (!s) return "waitlist";
  if (["x", "twitter", "x-ad", "x-ads", "xads", "twitter-ads", "twitterads", "t.co", "x.com", "twitter.com"].includes(s)) return "x-ad";
  return s;
}

export const blobPath = (email: string) => `waitlist/${email.replace(/[^a-z0-9@._+-]/g, "_")}.json`;

async function readJson(pathname: string): Promise<Signup | null> {
  const r = await get(pathname, { access: "private", useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  try {
    return JSON.parse(await new Response(r.stream).text()) as Signup;
  } catch {
    return null;
  }
}

export async function upsertSignup(s: Omit<Signup, "createdAt">): Promise<{ duplicate: boolean }> {
  const path = blobPath(s.email);
  const prev = await readJson(path).catch(() => null);
  const now = new Date().toISOString();
  const rec: Signup = prev
    ? { ...prev, company: s.company || prev.company, role: s.role || prev.role, source: prev.source || s.source, updatedAt: now }
    : { ...s, createdAt: now };
  await put(path, JSON.stringify(rec), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return { duplicate: !!prev };
}

export async function listSignups(): Promise<Signup[]> {
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: "waitlist/", cursor, limit: 1000 });
    paths.push(...page.blobs.map((b) => b.pathname).filter((p) => p.endsWith(".json")));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const out: Signup[] = [];
  for (let i = 0; i < paths.length; i += 20) {
    const chunk = await Promise.all(paths.slice(i, i + 20).map((p) => readJson(p).catch(() => null)));
    for (const s of chunk) if (s?.email) out.push(s);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const csvCell = (v: unknown) => {
  let s = String(v ?? "");
  if (/^[=+\-@]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: Signup[]) =>
  ["email,company,role,source,createdAt", ...rows.map((r) => [r.email, r.company, r.role, r.source, r.createdAt].map(csvCell).join(","))].join("\n") + "\n";
