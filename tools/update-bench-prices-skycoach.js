// Writes chrome-extension/bench-prices.json from the skycoach.gg leveling calculators:
// USA price of every level step per bench (Scrappy, workshop benches, Research Station, Outpost).
// The extension prices bench orders with it ("Research Station · Lvl 2→4" = step 2→3 + step 3→4).
//
// Usage: node tools/update-bench-prices-skycoach.js
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_JSON = path.join(ROOT, "chrome-extension", "bench-prices.json");
const BASE_URL = "https://skycoach.gg/arc-raiders-boost/products/";
const WORKSHOP = "workshop-leveling-8158";
const OUTPOST_UPGRADE = "outpost-upgrade-11309";
const OUTPOST_UNLOCK = "outpost-unlock-11313";
// Key of the USA region in range.prices ("2" is EU).
const USA = "1";
// Bench meta ids used by parser.js (BENCH_CATALOG).
const BENCH_IDS = new Set([
  "scrappy",
  "gunsmith",
  "gear-bench",
  "medical-lab",
  "explosives-station",
  "utility-station",
  "refiner",
  "research-station",
]);

// "Gear bench" -> "gear-bench".
const slug = (title) => title.trim().toLowerCase().replace(/\s+/g, "-");
const round = (p) => Math.round(p * 100) / 100;

async function fetchDifficulties(product) {
  const res = await fetch(`${BASE_URL}${product}`, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${product}`);
  return extractDifficulties(await res.text(), product);
}

// The calculator config is inline JSON: cut the "difficulties" array out by bracket matching.
function extractDifficulties(html, product) {
  const at = html.indexOf('"difficulties":[');
  if (at === -1) throw new Error(`difficulties not found on ${product}`);
  const start = html.indexOf("[", at);
  let depth = 0;
  for (let i = start; i < html.length; i += 1) {
    const c = html[i];
    if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error(`difficulties not closed on ${product}`);
}

// range.prices[USA] is either {"1": 5, "2": 7} or [1.5, 2, 2.5]: one price per level step.
function rangeSteps(range) {
  const raw = range?.prices?.[USA];
  if (!raw) return null;
  const steps = Array.isArray(raw)
    ? raw
    : Object.keys(raw).sort((a, b) => a - b).map((k) => raw[k]);
  return { min: range.borderValues[0], max: range.borderValues[1], steps: steps.map(round) };
}

(async () => {
  const benches = {};

  // Workshop Leveling: one calculator (difficulty) per bench.
  const workshop = await fetchDifficulties(WORKSHOP);
  for (const d of workshop) {
    const steps = rangeSteps(d.range);
    if (!steps) continue;
    const id = slug(d.title);
    if (!BENCH_IDS.has(id)) {
      console.warn(`Unknown bench on ${WORKSHOP}: "${d.title}"`);
      continue;
    }
    benches[id] = steps;
    if (id === "research-station") {
      const unlock = d.options.find((o) => /unlock/i.test(o.title));
      if (unlock) benches[id].unlock = round(unlock.USA.price);
    }
  }

  // Outpost: level range calculator + a discounted full 1-4 bundle; unlock is a separate product.
  const upgrade = await fetchDifficulties(OUTPOST_UPGRADE);
  const outpost = rangeSteps(upgrade.find((d) => d.range)?.range);
  if (outpost) {
    const full = upgrade.find((d) => /full/i.test(d.title) && d.price?.USA > 0);
    if (full) outpost.full = round(full.price.USA);
    const unlock = (await fetchDifficulties(OUTPOST_UNLOCK)).find((d) => /full/i.test(d.title) && d.price?.USA > 0);
    if (unlock) outpost.unlock = round(unlock.price.USA);
    benches.outpost = outpost;
  } else {
    console.warn(`No level range on ${OUTPOST_UPGRADE}`);
  }

  // Sanity check: the "to max level" price of each bench must equal the sum of its steps.
  const toMax = workshop.find((d) => /max/i.test(d.title));
  for (const o of toMax?.options || []) {
    const b = benches[slug(o.title)];
    if (!b) continue;
    const sum = b.steps.reduce((a, p) => a + p, 0);
    if (Math.abs(sum - o.USA.price) > 0.01) {
      console.warn(`${o.title}: to max is $${o.USA.price}, steps sum to $${sum.toFixed(2)}`);
    }
  }
  for (const id of BENCH_IDS) if (!benches[id]) console.warn(`No price for bench "${id}"`);

  const source = [WORKSHOP, OUTPOST_UPGRADE, OUTPOST_UNLOCK].map((p) => `${BASE_URL}${p}`);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify({ source, benches }, null, 2)}\n`);
  for (const [id, b] of Object.entries(benches)) {
    const extra = [b.full ? `full ${b.full}` : "", b.unlock ? `unlock ${b.unlock}` : ""].filter(Boolean).join(", ");
    console.log(`${id}: ${b.min}→${b.max} [${b.steps.join(", ")}]${extra ? ` ${extra}` : ""}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
