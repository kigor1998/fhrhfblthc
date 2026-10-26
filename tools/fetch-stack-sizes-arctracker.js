import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_JSON = path.join(ROOT, "chrome-extension", "stack-sizes.json");
const API_URL = "https://arctracker.io/api/items?locale=ru";

async function run() {
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data.items) ? data.items : [];

  const output = {};
  for (const it of list) {
    if (!it || !it.id) continue;
    const id = String(it.id).replace(/_/g, "-").trim();
    const stackSize = typeof it.stackSize === "number" ? it.stackSize : null;
    if (id && stackSize !== null) output[id] = stackSize;
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(output, null, 2));
  console.log(`Saved ${Object.keys(output).length} stack sizes to ${OUT_JSON}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
