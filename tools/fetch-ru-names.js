import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const ITEMS_JSON = path.join(ROOT, "chrome-extension", "items.json");
const OUT_JSON = path.join(ROOT, "chrome-extension", "ru-names.json");

const BASE_URL = "https://arcraiders.help/items/";
const CONCURRENCY = 4;
const DELAY_MS = 200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function decodeHtml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

async function fetchRuName(id) {
  const url = `${BASE_URL}${id}`;
  const res = await fetch(url, {
    headers: {
      "Accept-Language": "ru",
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (!match) return null;
  const name = decodeHtml(match[1].trim());
  if (!/[\u0400-\u04FF]/.test(name)) return null;
  return name;
}

async function run() {
  if (!fs.existsSync(ITEMS_JSON)) {
    throw new Error("items.json not found. Run build-extension-assets.js first.");
  }

  const items = JSON.parse(fs.readFileSync(ITEMS_JSON, "utf8"));
  const ids = items.map((it) => it.id).filter(Boolean);

  const results = {};
  let done = 0;

  async function worker(queue) {
    while (queue.length) {
      const id = queue.shift();
      try {
        const name = await fetchRuName(id);
        if (name) results[id] = name;
      } catch {
        // ignore network errors
      }
      done += 1;
      if (done % 25 === 0) {
        console.log(`Progress: ${done}/${ids.length}`);
      }
      await sleep(DELAY_MS);
    }
  }

  const queue = [...ids];
  const workers = Array.from({ length: CONCURRENCY }, () => worker(queue));
  await Promise.all(workers);

  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  console.log(`Saved ${Object.keys(results).length} RU names to ${OUT_JSON}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
