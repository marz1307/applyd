#!/usr/bin/env node
/**
 * apply.mjs — write email-derived stage transitions to Notion. The missing
 * second half of the email layer.
 *
 * probe.mjs classifies and proposes, then deliberately stops (WRITES_PERFORMED: 0).
 * Without a written second half, the actual writes get done by ad-hoc inline
 * PATCH scripts each time — same shape liveness-sweep had before --from-verdicts.
 * The stage scope, the sentinel wording and the dry-run tend to live in whatever
 * script happens to run that day, so the wording drifts and nothing stops a
 * bad proposal reaching a Stage 4+ row.
 *
 * SAFETY — why this is a file and not another inline script:
 *   - Dry run unless --apply.
 *   - isAutoAppliable is re-checked HERE. The input file is not trusted even
 *     though probe.mjs already filtered it; a hand-edited file must not be able
 *     to smuggle an interview invite past the gate.
 *   - Notion is re-read at write time. A proposal carries the stage the row had
 *     when the probe ran, which may be minutes or days stale: the row may have
 *     moved, or a human may have filed it already.
 *   - A row whose CURRENT stage is outside the legal set for that kind is
 *     refused, not written. Rejections may only land on a live applied row;
 *     confirmations may also land on "3. Drafted", which is the whole point of
 *     them — they record a submission the tracker missed.
 *   - The scan cursor advances only over messages whose write actually
 *     succeeded, so a half-failed run stays re-runnable rather than silently lost.
 *
 * Usage:
 *   node scripts/email/probe.mjs --in <messages.json> --apply-file data/.email-apply.json
 *   node scripts/email/apply.mjs --in data/.email-apply.json              # dry run
 *   node scripts/email/apply.mjs --in data/.email-apply.json --apply
 *   node scripts/email/apply.mjs --in data/.email-apply.json --apply --commit-cursor
 *   node scripts/email/apply.mjs --self-test
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAutoAppliable, RESPONDABLE_STAGES, CONFIRMABLE_STAGES } from "./match.mjs";
import { loadState, saveState, commit } from "./scan-state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const NOTION_QUERY = path.join(REPO, "scripts", "notion", "notion-query.mjs");
const NOTION = "https://api.notion.com/v1";

// ONE sentinel format. Both spellings may exist in Fit notes from ad-hoc
// hand-run days; keep them rather than inventing a third that greps differently.
const SENTINEL = { rejection: "[email-reject]", confirmation: "[email-confirm]" };
const MAX_RICH_TEXT = 1900;

/** Stages a row may legally be in for this kind of message to apply to it. */
export function legalStagesFor(kind) {
  return kind === "confirmation" ? CONFIRMABLE_STAGES : RESPONDABLE_STAGES;
}

/**
 * Decide what to do with one proposal against the row's LIVE state.
 * Pure, so the interesting cases are testable without Notion.
 */
export function planOne(proposal, liveRow) {
  const p = proposal || {};
  if (!isAutoAppliable(p)) return { action: "refuse", reason: `not auto-appliable (${p.kind}/${p.confidence})` };
  const cand = (p.candidates || [])[0];
  if (!cand) return { action: "refuse", reason: "proposal carries no candidate row" };
  if (!liveRow) return { action: "refuse", reason: `${cand.application_id} not found in Notion` };
  if (!p.proposed_stage) return { action: "refuse", reason: "proposal has no target stage" };

  if (liveRow.stage === p.proposed_stage) {
    return { action: "noop", reason: `already at ${p.proposed_stage}` };
  }
  const legal = legalStagesFor(p.kind);
  if (!legal.includes(liveRow.stage)) {
    // Covers the two cases that matter: the row moved on since the probe ran,
    // and a human already filed it.
    return { action: "refuse", reason: `row is at ${liveRow.stage}, not applicable for a ${p.kind}` };
  }
  return { action: "write", from: liveRow.stage, to: p.proposed_stage };
}

export function noteFor(proposal, today) {
  const s = SENTINEL[proposal.kind] || "[email]";
  const who = proposal.sender_name || proposal.sender || "unknown sender";
  const subj = String(proposal.subject || "").slice(0, 120);
  return `${s} ${today} ${proposal.kind} from ${who}: "${subj}" (gmail ${proposal.message_id})`;
}

/* ─────────────────────────────────────────────────────────── notion ──── */

function notionRows() {
  const out = execFileSync("node", [NOTION_QUERY, "--json"],
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // Exit 0 with an empty body has happened before; parsing it would look like
  // "no rows" and refuse every proposal for the wrong reason.
  if (!out || !out.trim()) throw new Error("notion-query returned an empty body (exit 0) — retry, do not trust it");
  return JSON.parse(out);
}

function headers() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN not set");
  return { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
}

async function writeRow(h, row, proposal, plan, today) {
  const props = { Stage: { select: { name: plan.to } } };

  const prior = row.fit_notes || "";
  const line = noteFor(proposal, today);
  // Trim the OLD text, never the new line, so the reason always survives.
  const merged = prior ? `${prior.slice(0, MAX_RICH_TEXT - line.length - 1)}\n${line}` : line;
  props["Fit notes"] = { rich_text: [{ text: { content: merged } }] };

  // A confirmation crossing 3. Drafted -> 4. Applied is evidence of a submission
  // the tracker never recorded, so it must carry the date, or the funnel counts
  // an applied row with no apply date.
  if (proposal.kind === "confirmation" && plan.from === "3. Drafted" && !row.apply_date) {
    props["Apply date"] = { date: { start: String(proposal.date || today).slice(0, 10) } };
  }

  const res = await fetch(`${NOTION}/pages/${row.id}`, {
    method: "PATCH", headers: h, body: JSON.stringify({ properties: props }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
}

/* ────────────────────────────────────────────────────────────── main ──── */

async function main(args) {
  const argOf = (n, d = null) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
  const IN = argOf("--in");
  const APPLY = args.includes("--apply");
  const COMMIT = args.includes("--commit-cursor");
  const JSON_OUT = args.includes("--json");

  if (!IN) {
    console.error("usage: node scripts/email/apply.mjs --in <apply-file.json> [--apply] [--commit-cursor] [--json]");
    process.exit(2);
  }

  const proposals = JSON.parse(readFileSync(IN, "utf8"));
  const rows = notionRows();
  const byId = new Map(rows.map((r) => [r.application_id, r]));
  const today = new Date().toISOString().slice(0, 10);

  const planned = proposals.map((p) => {
    const cand = (p.candidates || [])[0];
    const live = cand ? byId.get(cand.application_id) : null;
    return { p, live, plan: planOne(p, live) };
  });

  const log = (...a) => { if (!JSON_OUT) console.log(...a); };
  log("");
  log(`  ${proposals.length} proposal(s)  |  ${APPLY ? "MODE: APPLY" : "MODE: DRY RUN — pass --apply to write"}`);
  log("");
  for (const { p, live, plan } of planned) {
    const cand = (p.candidates || [])[0];
    const id = cand ? cand.application_id : "(none)";
    if (plan.action === "write") log(`  WRITE   ${id.padEnd(9)} ${plan.from} -> ${plan.to}   ${live.title}`);
    else if (plan.action === "noop") log(`  noop    ${id.padEnd(9)} ${plan.reason}`);
    else log(`  REFUSE  ${id.padEnd(9)} ${plan.reason}`);
  }

  let ok = 0, failed = 0;
  const written = [];
  if (APPLY) {
    const h = headers();
    log("");
    for (const { p, live, plan } of planned) {
      if (plan.action !== "write") continue;
      try {
        await writeRow(h, live, p, plan, today);
        ok++; written.push({ id: p.message_id, date: p.date });
        log(`  OK      ${live.application_id} -> ${plan.to}`);
      } catch (e) {
        failed++;
        log(`  FAILED  ${live.application_id}: ${e.message}`);
      }
      await new Promise((s) => setTimeout(s, 350));
    }
    // Only over messages that actually landed. A half-failed run stays re-runnable.
    if (COMMIT && written.length) saveState(commit(loadState(), written));
  }

  const counts = planned.reduce((a, x) => { a[x.plan.action] = (a[x.plan.action] || 0) + 1; return a; }, {});
  if (JSON_OUT) {
    console.log(JSON.stringify({
      planned: planned.map(({ p, plan }) => ({ message_id: p.message_id, kind: p.kind, plan })),
      counts, applied: APPLY, ok, failed,
    }, null, 2));
  } else {
    console.log("");
    console.log("--- EMAIL_APPLY_CONTRACT ---");
    console.log(`PROPOSALS: ${proposals.length}`);
    console.log(`PLANNED_WRITES: ${counts.write || 0}`);
    console.log(`NOOP: ${counts.noop || 0}`);
    console.log(`REFUSED: ${counts.refuse || 0}`);
    console.log(`WRITES_PERFORMED: ${ok}`);
    console.log(`WRITE_FAILED: ${failed}`);
    console.log(`CURSOR_COMMITTED: ${APPLY && COMMIT && written.length ? "yes" : "no"}`);
    console.log(`MODE: ${APPLY ? "apply" : "dry-run"}`);
    console.log("--- END ---");
  }
  process.exit(failed ? 1 : 0);
}

/* ───────────────────────────────────────────────────────── self-test ──── */

function selfTest() {
  let pass = 0, fail = 0;
  const ok = (c, l) => c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`));
  const prop = (over = {}) => ({
    message_id: "m1", date: "2026-08-18T10:00:00Z", sender: "no-reply@ashbyhq.com", sender_name: "Acme",
    subject: "Your application", kind: "rejection", confidence: "high", proposed_stage: "Rejected",
    candidates: [{ application_id: "APP-1", id: "p1", company: "Acme", stage: "4. Applied", matched_via: ["display_name"] }],
    ...over,
  });
  const row = (over = {}) => ({ application_id: "APP-1", id: "p1", title: "Acme", stage: "4. Applied", ...over });

  ok(planOne(prop(), row()).action === "write", "an unambiguous rejection on a live applied row is written");

  // The whole reason Notion is re-read instead of trusting the proposal.
  ok(planOne(prop(), row({ stage: "Rejected" })).action === "noop",
     "a row already at the target stage is a noop, not a second write");
  ok(planOne(prop(), row({ stage: "Withdrew" })).action === "refuse",
     "a row that moved to a terminal stage since the probe ran is refused");
  ok(planOne(prop(), row({ stage: "3. Drafted" })).action === "refuse",
     "a REJECTION cannot land on a Drafted row, it was never sent");

  // Confirmations legitimately reach Drafted; that is what recovers a row
  // sitting at Drafted while the confirmation mail is already in hand.
  const conf = prop({ kind: "confirmation", proposed_stage: "4. Applied" });
  ok(planOne(conf, row({ stage: "3. Drafted" })).action === "write",
     "a confirmation DOES apply to a Drafted row");

  // The input file is data, not authority.
  ok(planOne(prop({ kind: "interview", proposed_stage: "6. Phone screen" }), row()).action === "refuse",
     "an interview invite is refused even if it appears in the apply file");
  ok(planOne(prop({ confidence: "ambiguous" }), row()).action === "refuse",
     "an ambiguous proposal is refused even if it appears in the apply file");
  ok(planOne(prop(), null).action === "refuse", "a candidate missing from Notion is refused, not created");
  ok(planOne(prop({ candidates: [] }), row()).action === "refuse", "a proposal with no candidate is refused");

  const n = noteFor(prop(), "2026-08-18");
  ok(n.startsWith("[email-reject] 2026-08-18") && n.includes("gmail m1"),
     "the note carries one sentinel, the date and the message id");
  ok(noteFor(prop({ kind: "confirmation" }), "2026-08-18").startsWith("[email-confirm]"),
     "confirmations reuse the [email-confirm] sentinel");

  console.log(`\nSELF_TEST_${fail ? "FAIL" : "PASS"}: ${pass}/${pass + fail}`);
  return fail;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) process.exit(selfTest() ? 1 : 0);
  main(args).catch((e) => { console.error(`FATAL: ${e.message}`); process.exit(1); });
}

export default { planOne, noteFor, legalStagesFor };
