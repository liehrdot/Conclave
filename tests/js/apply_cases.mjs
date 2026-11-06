// Runs every case in docs/app-api/ops.json through the phone app's apply() + recompute() (sync/app/js/apply.js)
// and prints one line per case that differs from what the server's model holds afterwards. Called by
// tests/test_phone_app.py; the iPhone app's OptimisticTests compare the same way.
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { apply, recompute } from "../../src/mtgdeck/sync/app/js/apply.js";

const file = JSON.parse(readFileSync(new URL("../../docs/app-api/ops.json", import.meta.url)));

// the server makes up ids for notes written with a game; the phone can't know them
const maskNotes = (opponents) => (opponents || []).map((o) => ({ ...o,
  notes: (o.notes || []).map((n) => (n.game_id ? { ...n, id: null } : n)) }));

// the paths where two JSON values differ, e.g. "games[0].note: got undefined, want \"\""
function diff(got, want, path) {
  if (isDeepStrictEqual(got, want)) return [];
  if (got && want && typeof got === "object" && typeof want === "object" && Array.isArray(got) === Array.isArray(want)
      && (!Array.isArray(got) || got.length === want.length)) {
    const keys = new Set([...Object.keys(got), ...Object.keys(want)]);
    return [...keys].flatMap((k) => diff(got[k], want[k], Array.isArray(got) ? `${path}[${k}]` : `${path}.${k}`));
  }
  return [`${path}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`];
}

// what only the server can build; the phone shows it after its next read
const SERVER_ONLY = { "deck-new": /^decks\[\d+\]\.rule0(_en)?\./ };  // Rule 0 of a new deck (rule0.build, bracket table)

const problems = [];
for (const item of file.cases) {
  const base = file.bases[item.base];
  const got = structuredClone(base);
  try {
    apply(got, item.op);
    recompute(got);
  } catch (e) {
    problems.push(`${item.name}: throws ${e.message}`);
    continue;
  }
  const after = item.after || {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(after)])) {
    let want = key in after ? after[key] : base[key], mine = got[key];
    if (key === "opponents") { want = maskNotes(want); mine = maskNotes(mine); }
    for (const d of diff(mine, want, key)) if (!SERVER_ONLY[item.name]?.test(d)) problems.push(`${item.name}: ${d}`);
  }
}
console.log(problems.join("\n"));
process.exitCode = problems.length ? 1 : 0;
