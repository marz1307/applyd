// quick analysis helper — reads caveats-audit JSON and groups by folder + extension
import { execSync } from "node:child_process";
const d = JSON.parse(execSync("node caveats-audit.mjs --root output --top 0 --json", { maxBuffer: 50_000_000 }).toString());
const byFolder = {};
const byExt = { md: { em:0, en:0, files:0 }, html: { em:0, en:0, files:0 }, tex: { em:0, en:0, files:0 } };
for (const r of d.results) {
  const parts = r.file.replace(/\\/g, "/").split("/");
  const fld = parts[1] || "(root)";
  byFolder[fld] = byFolder[fld] || { files:0, em:0, en:0, nj:0 };
  byFolder[fld].files++;
  byFolder[fld].em += r.em;
  byFolder[fld].en += r.en;
  byFolder[fld].nj += (r.constructHits["not just"] || 0);
  const ext = (r.file.split(".").pop() || "").toLowerCase();
  if (byExt[ext]) { byExt[ext].files++; byExt[ext].em += r.em; byExt[ext].en += r.en; }
}
console.log("Per folder (dirty files only):");
for (const fld of Object.keys(byFolder).sort()) {
  const x = byFolder[fld];
  console.log(`  ${fld.padEnd(18)}  files=${String(x.files).padStart(3)}  em=${String(x.em).padStart(4)}  en=${String(x.en).padStart(4)}  not-just=${String(x.nj).padStart(3)}`);
}
console.log();
console.log("Per extension:");
for (const ext of Object.keys(byExt)) {
  const x = byExt[ext];
  console.log(`  .${ext.padEnd(5)} files=${String(x.files).padStart(3)}  em=${String(x.em).padStart(4)}  en=${String(x.en).padStart(4)}`);
}
