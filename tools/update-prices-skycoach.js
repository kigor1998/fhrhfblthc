// Updates per-unit prices in chrome-extension/items.json from skycoach.gg product pages.
// Option titles ("Queen Reactor x5", "Amplified Jupiter (Scoped)") are matched with the
// extension's own parser, and the unit price is the USA option price divided by the pack size.
//
// Usage: node tools/update-prices-skycoach.js
import fs from "fs";
import path from "path";
import vm from "vm";

const ROOT = process.cwd();
const EXT_DIR = path.join(ROOT, "chrome-extension");
const ITEMS_JSON = path.join(EXT_DIR, "items.json");
const PARSER_JS = path.join(EXT_DIR, "parser.js");

const BASE_URL = "https://skycoach.gg/arc-raiders-boost/products/";
const PRODUCTS = [
  "blueprints-9280",
  "equipment-9340",
  "keys-9341",
  "materials-9338",
  "weapon-mods-9339",
  "weapons-9337",
  "designs-11311",
  "stencils-11312",
  "ship-models-10496",
  "rubber-ducks-9881",
];
const ITEM_CLUSTERS = new Set([
  "Blueprints",
  "Items",
  "Keys",
  "Materials",
  "Attachments",
  "Amplified weapons",
  "Standard weapons",
  "Designs",
  "Stencils",
  "Ships",
  "Duck packs",
]);
// Clusters whose option titles omit the item kind ("Slipstream" is "Slipstream Stencil"):
// pass them as "Cluster: title" so the parser adds it.
const LABELED_CLUSTERS = new Set(["Blueprints", "Designs", "Stencils", "Ships"]);
const OPTION_RE =
  /\{"id":(\d+),"EU":\{.*?\},"USA":\{"price":([\d.]+),"disabled":(?:true|false),.*?"price_old":[\d.]+\},"group":[^,]*,"title":"((?:[^"\\]|\\.)*)","cluster":("(?:[^"\\]|\\.)*"|null),"disabled":(true|false)/g;

function extractOptions(html) {
  const seen = new Set();
  const out = [];
  for (const m of html.matchAll(OPTION_RE)) {
    const title = JSON.parse(`"${m[3]}"`);
    const cluster = JSON.parse(m[4]);
    if (m[5] === "true" || !ITEM_CLUSTERS.has(cluster) || seen.has(title)) continue;
    seen.add(title);
    out.push({ title, cluster, price: Number(m[2]) });
  }
  return out;
}

// Loads parseLine/buildIndex from parser.js without a browser (content.js owns `state` there).
function loadParser(items) {
  const ctx = { console, Intl, URL, state: {} };
  vm.createContext(ctx);
  vm.runInContext(
    `${fs.readFileSync(PARSER_JS, "utf8")}\n;globalThis.__api = { parseLine, buildIndex, prepareAmplified };`,
    ctx,
  );
  const api = ctx.__api;
  ctx.state.items = items;
  ctx.state.itemById = new Map(items.map((it) => [it.id, it]));
  api.prepareAmplified(items);
  const index = api.buildIndex(items);
  return (text) => api.parseLine(text, index).filter((e) => !e.meta);
}

(async () => {
  const items = JSON.parse(fs.readFileSync(ITEMS_JSON, "utf8"));
  const byId = new Map(items.map((it) => [it.id, it]));
  const parse = loadParser(items);

  const prices = new Map();
  const unmatched = [];
  for (const product of PRODUCTS) {
    const res = await fetch(`${BASE_URL}${product}`, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${product}`);
    const options = extractOptions(await res.text());
    console.log(`${product}: ${options.length} options`);
    for (const opt of options) {
      const text = LABELED_CLUSTERS.has(opt.cluster) ? `${opt.cluster}: ${opt.title}` : opt.title;
      const found = parse(text);
      const hit = found.length === 1 && found[0].item && !found[0].note ? found[0] : null;
      if (!hit || !(hit.qty > 0)) {
        unmatched.push(`[${opt.cluster}] ${opt.title}`);
        continue;
      }
      const unit = Math.round((opt.price / hit.qty) * 10000) / 10000;
      const prev = prices.get(hit.item.id);
      if (prev === undefined || unit < prev) prices.set(hit.item.id, unit);
    }
  }

  let changed = 0;
  for (const [id, unit] of prices) {
    const it = byId.get(id);
    if (it.price !== unit) changed += 1;
    it.price = unit;
    delete it.old_price;
    // Keep variant_name as the last key, like the rest of the file.
    const variants = it.variant_name;
    delete it.variant_name;
    it.variant_name = variants;
  }

  fs.writeFileSync(ITEMS_JSON, JSON.stringify(items, null, 2));
  console.log(`Prices from skycoach: ${prices.size} items (${changed} changed)`);
  if (unmatched.length) {
    console.log(`Not matched (${unmatched.length}), add a variant_name alias and rerun:`);
    for (const u of unmatched) console.log(`  ${u}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
