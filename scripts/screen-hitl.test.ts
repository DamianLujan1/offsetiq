// Screen mode, browser half: NDJSON parsing, operator review (exclude / re-rank / approve),
// the approved report's CSV, and the share link. Runs against a real agent proposal
// (tests/fixtures/proposal_tracts.json, kept current by tests/test_agent_contract.py).
// Run: npm run test:ts
import { readFileSync } from "node:fs";
import {
  analyzeHref, approve, binOf, buildReport, decodeReport, edited, encodeReport, included, move, ndjson, quintileBreaks, REPORT_COLUMNS,
  reportCsv, resetOrder, ringAcres, startReview, toggle, type Proposal,
} from "../lib/screen";

const P: Proposal = JSON.parse(readFileSync("tests/fixtures/proposal_tracts.json", "utf8"));
let fail = 0;
const check = (ok: boolean, name: string, extra = "") => { if (!ok) fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` ${extra}` : ""}`); };
const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

/** Minimal RFC-4180 reader, only to check what reportCsv writes. */
function parseCsv(s: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function main() {
  // 1) NDJSON arrives in arbitrary chunks
  const lines = ['{"type":"progress","done":1,"total":4}', '{"type":"progress","done":4,"total":4}'].join("\n") + "\n";
  let buf = "", got = 0;
  for (const chunk of [lines.slice(0, 7), lines.slice(7, 50), lines.slice(50)]) { const r = ndjson(buf + chunk); buf = r.rest; got += r.events.length; }
  check(got === 2 && buf === "", "ndjson: events split across chunks are reassembled");

  // 2) review: the agent proposes, the operator decides
  const ids = P.ranked.map((r) => r.id);
  let R = startReview(P);
  check(!edited(R, P) && R.approved === null, "review starts as the agent's order, unapproved");
  check(throws(() => buildReport(P, R, "plan")), "no export before approval");
  R = approve(R, "2026-10-27T12:00:00.000Z");
  check(R.approved!.ids.join() === ids.join(), "approval snapshots the included list in order");
  R = toggle(R, ids[1]);
  check(R.approved === null, "excluding a row clears the approval");
  R = move(R, ids[4], -1);
  check(included(R).join() === [ids[0], ids[2], ids[4], ids[3], ids[5]].join(), "exclude + move up keeps everyone else in agent order");
  check(move(R, ids[0], -1) === R && move(R, ids[5], 1) === R, "moving past either end is a no-op");
  check(edited(R, P), "edits are detected");
  R = resetOrder(R, P);
  check(R.order.join() === ids.join() && R.excluded.length === 1, "reset restores agent order, keeps exclusions");
  R = toggle(R, ids[1]);
  check(!edited(R, P), "un-excluding the row returns to the agent's list");

  // 3) the approved report
  R = approve(move(toggle(startReview(P), ids[2]), ids[3], -1), "2026-10-27T12:00:00.000Z");
  const rep = buildReport(P, R, "Compare the two tracts.");
  check(rep.rows.length === ids.length - 1 && !rep.rows.some((r) => r.id === ids[2]), "report holds only approved rows");
  // ids[3] moved above the (still visible, greyed) excluded ids[2], so among kept rows it is third.
  check(rep.rows.map((r) => r.rank).join() === "1,2,3,4,5" && rep.rows.map((r) => r.id).join() === [ids[0], ids[1], ids[3], ids[4], ids[5]].join()
    && rep.rows[2].agentRank === 4, "rows renumbered in operator order, agent rank kept");
  check(rep.rows.every((r, i) => r.headline === P.ranked.find((x) => x.id === r.id)!.rationale.headline), "rationales travel with their rows");
  check(rep.edited && rep.proposed === ids.length, "report records that the operator edited the list");

  // 4) CSV: rationale included, every row has every column, escaping holds
  const tricky = { ...rep, prompt: 'compare "North", South\nplease', rows: rep.rows.map((r, i) => (i ? r : { ...r, region: 'Tract "A", east', why: "line1\nline2" })) };
  const csv = reportCsv(tricky, "https://offsetiq.example");
  const body = csv.split("\n").filter((l) => !l.startsWith("#")).join("\n");
  const grid = parseCsv(body);
  check(grid[0].join("|") === REPORT_COLUMNS.join("|"), "CSV header is the documented column list");
  check(grid.length - 1 === rep.rows.length && grid.slice(1).every((r) => r.length === REPORT_COLUMNS.length), "CSV: one full-width row per approved location",
    `(${grid.length - 1} rows)`);
  const first = grid[1];
  check(first[3] === 'Tract "A", east' && first[22] === "line1\nline2", "CSV escaping round-trips quotes, commas and newlines");
  check(first[20] === rep.rows[0].headline && first[21] === rep.rows[0].details.join(" "), "CSV carries the rationale");
  check(first[23].startsWith("https://offsetiq.example/analyze?lat="), "CSV links each row to the Analyze page");
  check(csv.startsWith("# OffsetIQ screening report: compare \"North\", South please\n# Approved by the operator 2026-10-27T12:00:00.000Z: 5 of 6"),
    "CSV header states prompt and approval");
  check(/never given volumes/.test(csv) && /not a reserves report/.test(csv), "CSV states the data rules");

  // 5) share link: the report itself, compressed into the fragment; anything malformed is rejected
  const enc = await encodeReport(rep);
  const dec = await decodeReport(enc);
  check(enc.startsWith("z.") && JSON.stringify(dec) === JSON.stringify(rep), "share link round-trips the report", `(${enc.length} chars)`);
  const plain = "j." + Buffer.from(JSON.stringify(rep)).toString("base64url");
  check(JSON.stringify(await decodeReport(plain)) === JSON.stringify(rep), "uncompressed fallback decodes");
  const bad = async (o: unknown) => decodeReport("j." + Buffer.from(JSON.stringify(o)).toString("base64url"));
  check(await decodeReport("z.not-base64!!") === null && await decodeReport("x.abc") === null && await decodeReport("") === null, "garbage links are rejected");
  check(await bad({ ...rep, v: 2 }) === null, "unknown report version is rejected");
  check(await bad({ ...rep, rows: [{ ...rep.rows[0], lat: "31.9" }] }) === null, "non-numeric coordinates are rejected");
  check(await bad({ ...rep, rows: [{ ...rep.rows[0], cum12: { p10: 1, p50: null, p90: 3 } }] }) === null, "missing forecast numbers are rejected");
  check(await bad({ ...rep, filters: { ...rep.filters, min_lat_ft: "javascript:alert(1)" } }) === null, "non-numeric filters are rejected");
  check(await decodeReport("j." + "A".repeat(400_001)) === null, "oversized links are rejected");
  const href = analyzeHref(31.9, -102.1, 10000, 1, { min_lat_ft: null, max_lat_ft: null, operator: '"><script>', min_first_ym: null, max_first_ym: null });
  check(href.startsWith("/analyze?lat=31.900000&lon=-102.100000&lat_ft=10000&r=1&op=") && !href.includes("<"), "Analyze links are rebuilt from numbers and encoded");

  // 6) contract with the agent's proposal
  check(P.ranked.every((r) => r.rationale.headline.startsWith(`Rank #${r.rank}:`) && r.rationale.details.length > 0 && r.rationale.why.length > 0),
    "every proposed row carries a rationale");
  check(P.candidates.lat.length === P.run.candidates && P.candidates.status.every((s) => ["ranked", "no_model_offsets", "outside_coverage"].includes(s)),
    "candidate arrays match the run");

  // 7) map helpers
  const qb = quintileBreaks([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  check(qb.join() === "2,4,6,8,10", "quintile breaks are equal-count bins");
  check(quintileBreaks([5, 5, 5]).join() === "5" && quintileBreaks([]).length === 0, "identical or no values collapse cleanly");
  check(binOf(qb, 1) === 0 && binOf(qb, 4.5) === 2 && binOf(qb, 10) === 4 && binOf(qb, 99) === 4, "values map to their quintile");
  const dLat = 1 / 69.0933, dLon = 1 / (69.0933 * Math.cos((31.907 * Math.PI) / 180));
  const acres = ringAcres([[31.9, -102.1], [31.9, -102.1 + dLon], [31.9 + dLat, -102.1 + dLon], [31.9 + dLat, -102.1]]);
  check(Math.abs(acres - 640) < 3, "a drawn 1-mile square reads as ~640 acres", `(${acres.toFixed(1)})`);
  process.exit(fail ? 1 : 0);
}
main();
