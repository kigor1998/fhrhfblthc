import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const ITEMS_JSON = path.join(ROOT, "chrome-extension", "items.json");
const OUT_JSON = path.join(ROOT, "chrome-extension", "ru-names.json");
const API_URL = "https://arctracker.io/api/items?locale=ru";

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/&/g, " and ")
    .replace(/blueprints?/g, " blueprint ")
    .replace(/mk\.?\s*([0-9]+)/g, "mk $1")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function run() {
  if (!fs.existsSync(ITEMS_JSON)) {
    throw new Error("items.json not found. Run tools/build-extension-assets.js first.");
  }

  const items = JSON.parse(fs.readFileSync(ITEMS_JSON, "utf8"));

  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data.items) ? data.items : [];

  const byId = new Map();
  const byName = new Map();
  const nameCounts = new Map();

  for (const it of list) {
    const en = it?.name?.en;
    const ru = it?.name?.ru;
    if (!en || !ru) continue;

    const idKebab = String(it.id || "").replace(/_/g, "-").trim();
    if (idKebab) byId.set(idKebab, ru);

    const norm = normalize(en);
    nameCounts.set(norm, (nameCounts.get(norm) || 0) + 1);
    if (!byName.has(norm)) byName.set(norm, ru);
  }

  const output = {};
  let matched = 0;

  for (const item of items) {
    const id = item.id;
    const norm = normalize(item.name || "");
    let ru = byId.get(id);
    if (!ru && nameCounts.get(norm) === 1) {
      ru = byName.get(norm);
    }
    if (ru) {
      output[id] = ru;
      matched += 1;
    }
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(output, null, 2));
  console.log(`Matched ${matched}/${items.length} RU names -> ${OUT_JSON}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
