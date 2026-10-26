// Updates chrome-extension/items.json from the MetaForge API (https://metaforge.app/arc-raiders).
// Keeps manual data from the current items.json (price, old_price, variant_name, name_ru),
// downloads missing icons and fills RU names / stack sizes from arctracker.io.
//
// Usage: node tools/update-from-metaforge.js
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "chrome-extension");
const ICON_DIR = path.join(OUT_DIR, "assets", "icons");
const ITEMS_JSON = path.join(OUT_DIR, "items.json");
const RU_OVERRIDES_JSON = path.join(OUT_DIR, "ru-names-overrides.json");
const BENCHES_JSON = path.join(OUT_DIR, "benches.json");
const WEAPON_RECIPES_JSON = path.join(OUT_DIR, "weapon-recipes.json");

const METAFORGE_API = "https://metaforge.app/api/arc-raiders/items";
const METAFORGE_HIDEOUT_API = "https://metaforge.app/api/arc-raiders/hideout";
const METAFORGE_ICON_CDN = "https://cdn.metaforge.app/arc-raiders/icons";
const ARCTRACKER_API = "https://arctracker.io/api/items?locale=ru";

// Hideout furniture itself and research projects are not sold; furniture Designs are.
const EXCLUDED_TYPES = new Set(["Furniture", "Research"]);
// "coins" clashes with the built-in arc-coins currency item.
const EXCLUDED_IDS = new Set(["coins", "research-points"]);

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/&/g, " and ")
    .replace(/blueprints?/g, " blueprint ")
    .replace(/mk\.?\s*([0-9]+)/g, "mk $1")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "Amplified Aphelion (Bigger Mag, Charged Burst)" (MetaForge) or
// "Amplified Aphelion · Bigger Mag + Charged Burst" (arctracker) -> { base, mods }
function parseAmplified(name) {
  const m = String(name || "").match(/^Amplified\s+(.+?)(?:\s*\((.*)\)|\s*·\s*(.*))?\s*$/);
  if (!m) return null;
  const modsRaw = m[2] ?? m[3] ?? "";
  const mods = modsRaw
    .split(/,|\+/)
    .map((x) => normalize(x))
    .filter(Boolean);
  return { base: normalize(m[1]), mods };
}

function ampKey(amp) {
  return `${amp.base}|${[...amp.mods].sort().join("|")}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchMetaforgeItems() {
  const out = [];
  for (let page = 1; ; page += 1) {
    const data = await fetchJson(`${METAFORGE_API}?page=${page}&limit=100`);
    out.push(...(data.data || []));
    if (!data.pagination?.hasNextPage) break;
  }
  return out;
}

// Workbench upgrade costs: { id, name, maxLevel, levels: { "2": [{ id, qty }] } }
async function updateBenches() {
  const stations = await fetchJson(METAFORGE_HIDEOUT_API);
  const out = stations.map((st) => ({
    id: st.id,
    name: st.name,
    maxLevel: st.maxLevel,
    levels: Object.fromEntries(
      Object.entries(st.levels || {}).map(([lvl, data]) => [
        lvl,
        (data?.requiredItems || []).map((r) => ({ id: r.id, qty: r.quantity })),
      ]),
    ),
  }));
  fs.writeFileSync(BENCHES_JSON, JSON.stringify(out, null, 2));
  console.log(`Saved ${out.length} workbenches to ${BENCHES_JSON}`);
}

// Weapon crafting (tier I recipe) and upgrade (I -> IV) costs from arctracker, keyed by base name ("anvil").
// Used for bundle orders like "Crafting materials: 5 guns".
function updateWeaponRecipes(atItems, ourItems) {
  const byId = new Map(atItems.map((it) => [it.id, it]));
  const ourIds = new Set(ourItems.map((it) => it.id));
  const ourByName = new Map(ourItems.map((it) => [normalize(it.name), it.id]));
  // arctracker "wires" is "wires-recipe" in items.json: fall back to the English name.
  const toOurId = (atId) => {
    const kebab = atId.replace(/_/g, "-");
    if (ourIds.has(kebab)) return kebab;
    return ourByName.get(normalize(byId.get(atId)?.name?.en || "")) || null;
  };
  const toList = (cost) =>
    Object.entries(cost || {})
      .map(([id, qty]) => ({ id: toOurId(id), qty }))
      .filter((r) => r.id);
  const add = (totals, cost) => {
    for (const r of toList(cost)) totals.set(r.id, (totals.get(r.id) || 0) + r.qty);
  };
  const out = {};
  for (const it of atItems) {
    if (!it?.isWeapon || !it.recipe || /_amplified/.test(it.id)) continue;
    const en = it.name?.en || "";
    const base = normalize(en.replace(/\s+(?:I|II|III|IV|V)$/, ""));
    if (!base || out[base]) continue;
    const upgrade = new Map();
    for (let next = byId.get(it.upgradesTo); next && !/_amplified/.test(next.id); next = byId.get(next.upgradesTo)) {
      add(upgrade, next.upgradeCost);
    }
    out[base] = {
      name: en.replace(/\s+(?:I|II|III|IV|V)$/, ""),
      craft: toList(it.recipe),
      upgrade: [...upgrade].map(([id, qty]) => ({ id, qty })),
    };
  }
  fs.writeFileSync(WEAPON_RECIPES_JSON, JSON.stringify(out, null, 2));
  console.log(`Saved ${Object.keys(out).length} weapon recipes to ${WEAPON_RECIPES_JSON}`);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function download(url, dest, attempts = 3) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) return false;
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return true;
    } catch (err) {
      // Network hiccups (connection reset) are common on bulk downloads: retry, then give up on this icon.
      if (i === attempts) {
        console.warn(`Download failed: ${url} (${err.message})`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  return false;
}

function findExistingIcon(id) {
  for (const ext of [".webp", ".png"]) {
    if (fs.existsSync(path.join(ICON_DIR, `${id}${ext}`))) return `${id}${ext}`;
  }
  return null;
}

const iconByUrl = new Map();
async function ensureIcon(item) {
  const existing = findExistingIcon(item.id);
  if (existing) return existing;
  // Old CDN has small webp icons for most items.
  const webpName = `${item.id}.webp`;
  if (await download(`${METAFORGE_ICON_CDN}/${item.id}.webp`, path.join(ICON_DIR, webpName))) {
    return webpName;
  }
  if (!item.icon) return null;
  // Amplified variants share one picture per base weapon, so reuse one file per URL.
  if (iconByUrl.has(item.icon)) return iconByUrl.get(item.icon);
  const ext = path.extname(new URL(item.icon).pathname) || ".png";
  const amp = item.item_type === "Weapon" ? parseAmplified(item.name) : null;
  const fileName = amp ? `amplified-${amp.base.replace(/ /g, "-")}${ext}` : `${item.id}${ext}`;
  if (!fs.existsSync(path.join(ICON_DIR, fileName))) {
    if (!(await download(item.icon, path.join(ICON_DIR, fileName)))) return null;
  }
  iconByUrl.set(item.icon, fileName);
  return fileName;
}

function buildArctrackerLookup(list) {
  const byId = new Map();
  const byName = new Map();
  const nameCounts = new Map();
  const byAmp = new Map();
  for (const it of list) {
    const en = it?.name?.en;
    const entry = { ru: it?.name?.ru || null, stackSize: typeof it.stackSize === "number" ? it.stackSize : null };
    const idKebab = String(it.id || "").replace(/_/g, "-").trim();
    if (idKebab) byId.set(idKebab, entry);
    if (!en) continue;
    const norm = normalize(en);
    nameCounts.set(norm, (nameCounts.get(norm) || 0) + 1);
    if (!byName.has(norm)) byName.set(norm, entry);
    const amp = parseAmplified(en);
    if (amp) byAmp.set(ampKey(amp), entry);
  }
  return (item) => {
    const amp = item.item_type === "Weapon" ? parseAmplified(item.name) : null;
    if (amp && byAmp.has(ampKey(amp))) return byAmp.get(ampKey(amp));
    if (amp) {
      // MetaForge "amplified-rascal-incendiary-rounds" <-> arctracker "rascal_amplified_incendiary_rounds".
      const baseSlug = amp.base.replace(/ /g, "-");
      const rest = item.id.replace(new RegExp(`^amplified-${baseSlug}`), "");
      const alt = byId.get(`${baseSlug}-amplified${rest}`);
      if (alt) return alt;
    }
    if (byId.has(item.id)) return byId.get(item.id);
    const norm = normalize(item.name);
    if (nameCounts.get(norm) === 1) return byName.get(norm);
    return null;
  };
}

function isUsableRu(ru, en) {
  // arctracker sometimes returns the English name for untranslated items.
  return Boolean(ru) && /[Ѐ-ӿ]/.test(ru) && ru !== en;
}

(async () => {
  fs.mkdirSync(ICON_DIR, { recursive: true });

  const oldItems = readJson(ITEMS_JSON, []);
  const oldById = new Map(oldItems.map((it) => [it.id, it]));
  const ruOverrides = readJson(RU_OVERRIDES_JSON, {});

  console.log("Fetching MetaForge items...");
  const mfItems = await fetchMetaforgeItems();
  console.log(`MetaForge: ${mfItems.length} items`);

  let arctracker = () => null;
  let atItems = [];
  try {
    const data = await fetchJson(ARCTRACKER_API);
    atItems = Array.isArray(data.items) ? data.items : [];
    arctracker = buildArctrackerLookup(atItems);
  } catch (err) {
    console.warn(`arctracker unavailable, RU names for new items will be empty: ${err.message}`);
  }

  const output = [];
  const seen = new Set();
  const stats = { added: 0, updated: 0, kept: 0, noIcon: [], noRu: [] };

  for (const mf of mfItems) {
    if (!mf?.id || seen.has(mf.id)) continue;
    if (EXCLUDED_TYPES.has(mf.item_type) || EXCLUDED_IDS.has(mf.id)) continue;
    seen.add(mf.id);

    const old = oldById.get(mf.id);
    const name = String(mf.name || "").trim();
    const iconFile = await ensureIcon({ ...mf, name });
    if (!iconFile) {
      stats.noIcon.push(mf.id);
      continue;
    }

    const at = arctracker({ id: mf.id, name, item_type: mf.item_type });
    const isBlueprint = mf.item_type === "Blueprint" || / blueprint$/i.test(name);
    const mfStack = mf.stat_block?.stackSize;
    const stackSize = isBlueprint
      ? 1
      : typeof mfStack === "number" && mfStack > 0
        ? mfStack
        : old?.stack_size ?? at?.stackSize ?? null;

    // Keep the previous name as an alias so old order texts still match.
    const variants = Array.isArray(old?.variant_name) ? [...old.variant_name] : [];
    if (old?.name && normalize(old.name) !== normalize(name)) {
      if (!variants.some((v) => normalize(v) === normalize(old.name))) variants.push(old.name.trim());
    }

    const nameRu =
      ruOverrides[mf.id] ??
      (old?.name_ru || (isUsableRu(at?.ru, name) ? at.ru : ""));
    if (!nameRu) stats.noRu.push(mf.id);

    const record = {
      id: mf.id,
      name,
      name_ru: nameRu,
      item_type: mf.item_type,
      rarity: mf.rarity ?? "",
      value: typeof mf.value === "number" ? mf.value : null,
      stack_size: stackSize,
      ammo_type: mf.ammo_type ?? "",
      icon_file: `assets/icons/${iconFile}`,
    };
    const amp = mf.item_type === "Weapon" ? parseAmplified(name) : null;
    if (amp) {
      record.amp_base = amp.base;
      record.amp_mods = amp.mods;
    }
    if (old && "price" in old) record.price = old.price;
    if (old && "old_price" in old) record.old_price = old.old_price;
    record.variant_name = variants;

    output.push(record);
    if (old) stats.updated += 1;
    else stats.added += 1;
  }

  // Items that MetaForge no longer lists are kept as they were.
  for (const old of oldItems) {
    if (seen.has(old.id)) continue;
    output.push(old);
    stats.kept += 1;
  }

  output.sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(ITEMS_JSON, JSON.stringify(output, null, 2));

  console.log(
    `Saved ${output.length} items (added ${stats.added}, updated ${stats.updated}, kept old-only ${stats.kept})`,
  );
  if (stats.noIcon.length) console.log(`Skipped (no icon): ${stats.noIcon.join(", ")}`);
  if (stats.noRu.length) console.log(`No RU name (${stats.noRu.length}): ${stats.noRu.join(", ")}`);

  await updateBenches();
  if (atItems.length) updateWeaponRecipes(atItems, output);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
