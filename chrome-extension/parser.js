// Order text parser: item/bench dictionaries and parseLine(). No DOM or chrome.* access, so the
// tools/ scripts can run it in Node. Loaded before content.js, which owns `state`.

const META_LABELS = new Set([
  "platform",
  "completion method",
  "delivery method",
  "vpn location",
  "extras",
  "boosting options",
  "completion speed",
]);
const IGNORE_TOKENS = new Set([
  "psn",
  "ps4",
  "ps5",
  "playstation",
  "xbox",
  "pc",
  "ps",
]);
const IGNORE_PHRASES = new Set([
  "piloted only",
  "self play only",
  "self-play only",
  "in transfer",
  "arc raiders",
  "for",
]);
// "Label: value" pairs from service orders (raids, leveling) shown as plain badges.
const SERVICE_LABELS = new Set([
  "completions",
  "extractions",
  "loot value",
  "map condition",
  "faction",
  "outpost",
  "research station",
  "workshop",
  "leveling",
  "levelling",
  "region",
  "reward pass",
]);
// Labels whose value lists items: an unknown value there stays red. Any other unknown "Label: value"
// (raid mode, rank, quest giver, bundle tier, ...) is shown as a plain badge.
const ITEM_LABEL_RE =
  /blueprint|material|\bkeys?\b|\bitems?\b|weapon|\bparts?\b|ships?|stencils?|designs?|ammo|quick use|augment|shield|attachments?|duck|\bmods?\b/i;
// "Queen Kill + All Loot", "Assessor + Vaporizer": "+" inside these values is not an item separator.
const NO_PLUS_SPLIT_LABELS = new Set([
  "boosting options",
  "options",
  "option",
  "loot options",
  "bundle tier",
  "extras",
  "outpost",
  "research station",
]);
// Item labels whose values omit the item kind: "Stencils: Slipstream" -> "Slipstream Stencil".
const LABEL_NAME_SUFFIX = {
  stencils: "stencil",
  stencil: "stencil",
  designs: "design",
  design: "design",
  ships: "ship model",
  ship: "ship model",
  "ship models": "ship model",
};
const LEVELING_TARGET_RE =
  /^(?:arc\s+raiders\s+)?(?:add\s+)?(research\s+station|outpost|oupost|workshop|reward\s+pass|legacy\s+pass|expedition)\s+(?:leveling|levelling|upgrade|level)\b\s*:?\s*(.*)$/i;
const REGION_RE = /^(usa|us|eu|europe|na|asia|uk|canada)$/i;
// Extra spellings for amplified weapon mods (canonical names come from items.json).
const AMP_MOD_EXTRA_ALIASES = {
  "bigger mag": ["big mag", "bigger magazine", "larger mag", "extended mag", "bigger mags"],
  "drum mag": ["drum magazine", "drum"],
  "incendiary rounds": ["incendiary round", "incendiary ammo", "incendiary bullets", "incendiary"],
  "incendiary grenades": ["incendiary grenade", "incendiary nades", "incendiary"],
  "tracker rounds": ["tracker round", "tracker ammo", "tracker"],
  "slug rounds": ["slug round", "slug ammo", "slugs", "slug"],
  "x rounds": ["x round"],
  "anti weak point": ["anti weakpoint", "anti weak spot", "anti weakspot"],
  "sprint shooting": ["sprint shot", "sprint fire"],
  "semi auto": ["semiauto"],
  "full auto": ["fullauto"],
  "scoped": ["scope"],
  "carbine conversion": ["carbine"],
};
const BENCH_CATALOG = [
  { id: "scrappy", label: "Scrappy", aliases: ["scrappy"] },
  { id: "gunsmith", label: "Gunsmith", aliases: ["gunsmith", "gunbench", "gun bench"] },
  { id: "gear-bench", label: "Gear Bench", aliases: ["gear bench", "gearbench"] },
  { id: "medical-lab", label: "Medical Lab", aliases: ["medical lab"] },
  { id: "explosives-station", label: "Explosives Station", aliases: ["explosives station", "explosive station"] },
  { id: "utility-station", label: "Utility Station", aliases: ["utility station"] },
  { id: "refiner", label: "Refiner", aliases: ["refiner"] },
];
// Bench meta id -> station id in benches.json (MetaForge hideout data).
const BENCH_HIDEOUT_IDS = {
  scrappy: "scrappy",
  gunsmith: "weapon-bench",
  "gear-bench": "equipment-bench",
  "medical-lab": "med-station",
  "explosives-station": "explosives-bench",
  "utility-station": "utility-bench",
  refiner: "refiner",
  "research-station": "research-station",
  outpost: "outpost",
};

function findBenchInText(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const bench of BENCH_CATALOG) {
    for (const alias of bench.aliases) {
      const pattern = new RegExp(`\\b${alias.replace(/\\s+/g, "\\\\s+")}\\b`, "i");
      if (pattern.test(lower)) return bench;
    }
  }
  return null;
}

function extractBenchesFromText(text) {
  if (!text) return [];
  const parts = text.split(/,|\+|\band\b|\//i).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const part of parts.length ? parts : [text]) {
    const bench = findBenchInText(part);
    if (!bench) continue;
    const priceMatch = part.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
    const price = priceMatch ? Number(priceMatch[1]) : null;
    const levelMatch =
      part.match(/\blvl\s*([0-9]+)(?:\s*-\s*([0-9]+))?/i) ||
      part.match(/\blevel\s*([0-9]+)(?:\s*-\s*([0-9]+))?/i);
    const current = levelMatch ? parseInt(levelMatch[1], 10) : null;
    const desired = levelMatch && levelMatch[2] ? parseInt(levelMatch[2], 10) : null;
    const existing = out.find((b) => b.id === bench.id);
    if (existing) {
      if (Number.isFinite(price)) existing.price = price;
      if (Number.isFinite(current)) existing.current = current;
      if (Number.isFinite(desired)) existing.desired = desired;
    } else {
      out.push({ ...bench, price, current, desired });
    }
  }
  return out;
}

function calcOrderTotalPrice(order) {
  if (!order || !Array.isArray(order.items)) return null;
  let total = 0;
  let hasPrice = false;
  for (const item of order.items) {
    if (!item) continue;
    const base = state.itemById?.get(item.id) || item;
    const qty = Number(item.qty) || 0;
    const itemTotal = calcItemTotalPrice(base, qty);
    if (Number.isFinite(itemTotal)) {
      total += itemTotal;
      hasPrice = true;
    }
  }
  return hasPrice ? total : null;
}

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/heavey/g, "heavy")
    .replace(/\bblue\s*prints?\b/g, "blueprint")
    .replace(/\bstill?etto\b/g, "stiletto")
    .replace(/\bgrenad\b/g, "grenade")
    .replace(/\brascall\b/g, "rascal")
    .replace(/\bamp(?:ed)?\b/g, "amplified")
    .replace(/&/g, " and ")
    .replace(/blueprints?/g, " blueprint ")
    .replace(/\btier\s*([ivx]+)\b/g, "$1")
    .replace(/\btier\s*(\d+)\b/g, "$1")
    .replace(/mk\.?\s*([0-9]+)/g, "mk $1")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearch(s) {
  return s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9а-яё]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseQtyToken(token) {
  if (!token) return null;
  const t = token.toLowerCase();
  if (t.endsWith("k")) return parseInt(t, 10) * 1000;
  if (t.endsWith("m")) return parseInt(t, 10) * 1000000;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

function buildIndex(items) {
  const idx = [];
  const seen = new Set();
  // rank 0 = real name or manual variant, 1 = derived alias (plural, "blueprint" stripped, ...).
  const addAlias = (key, item, rank = 1) => {
    if (!key || seen.has(`${item.id}:${key}`)) return;
    seen.add(`${item.id}:${key}`);
    idx.push({ key, item, rank });
  };

  const pluralize = (key) => {
    const parts = key.split(" ");
    if (!parts.length) return null;
    const last = parts[parts.length - 1];
    if (last.endsWith("y")) {
      parts[parts.length - 1] = `${last.slice(0, -1)}ies`;
    } else if (/(s|x|z|ch|sh)$/.test(last)) {
      parts[parts.length - 1] = `${last}es`;
    } else {
      parts[parts.length - 1] = `${last}s`;
    }
    return parts.join(" ");
  };

  for (const it of items) {
    const norm = normalize(it.name);
    if (!norm) continue;
    addAlias(norm, it, 0);
    const variants = Array.isArray(it.variant_name)
      ? it.variant_name
      : Array.isArray(it.variant_names)
        ? it.variant_names
        : typeof it.variant_name === "string"
          ? [it.variant_name]
          : typeof it.variant_names === "string"
            ? [it.variant_names]
            : [];
    for (const v of variants) {
      const vNorm = normalize(v);
      if (vNorm) {
        addAlias(vNorm, it, 0);
        addAlias(pluralize(vNorm), it);
      }
    }
    if (/\bgrenade\b|\bnade\b/.test(norm)) {
      const noGrenade = norm
        .replace(/\bgrenade\b/g, " ")
        .replace(/\bnade\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (noGrenade) addAlias(noGrenade, it);
      const noGrenadePlural = pluralize(noGrenade);
      if (noGrenadePlural) addAlias(noGrenadePlural, it);
    }

    // Map "magazine" <-> "mag"
    if (norm.includes("magazine")) {
      const magAlias = norm.replace(/\bmagazine\b/g, "mag").trim();
      if (magAlias) addAlias(magAlias, it);
      const magPlural = pluralize(magAlias);
      if (magPlural) addAlias(magPlural, it);
    }
    if (norm.includes("mag")) {
      const magazineAlias = norm.replace(/\bmag\b/g, "magazine").trim();
      if (magazineAlias) addAlias(magazineAlias, it);
      const magazinePlural = pluralize(magazineAlias);
      if (magazinePlural) addAlias(magazinePlural, it);
    }

    if (it.item_type === "Blueprint" || / blueprint$/i.test(it.name)) {
      const alias = norm.replace(/\bblueprint\b/g, "").trim();
      if (alias) addAlias(alias, it);
      const aliasPlural = pluralize(alias);
      if (aliasPlural) addAlias(aliasPlural, it);
    }

    if (it.item_type === "Weapon") {
      const base = norm.replace(
        /\b(rifle|shotgun|pistol|smg|lmg|sniper|marksman|launcher)\b/g,
        "",
      ).replace(/\s+/g, " ").trim();
      if (base && base !== norm) {
        addAlias(base, it);
        const basePlural = pluralize(base);
        if (basePlural) addAlias(basePlural, it);
      }
    }

    const plural = pluralize(norm);
    if (plural) addAlias(plural, it);

    // Map "Reactor" -> "Core" (Queen cores, Matriarch cores)
    if (norm.endsWith(" reactor")) {
      const coreAlias = norm.replace(/\breactor\b$/, "core").trim();
      if (coreAlias) addAlias(coreAlias, it);
      const corePlural = pluralize(coreAlias);
      if (corePlural) addAlias(corePlural, it);
    }
  }
  idx.sort((a, b) => b.key.length - a.key.length || a.rank - b.rank);
  return idx;
}

function buildItemLabelIndex(items) {
  const map = new Map();
  for (const item of items) {
    const names = [
      item.id,
      item.name,
      item.name_ru,
      item.short_name,
    ].filter(Boolean);
    const variants = Array.isArray(item.variant_name)
      ? item.variant_name
      : Array.isArray(item.variant_names)
        ? item.variant_names
        : typeof item.variant_name === "string"
          ? [item.variant_name]
          : typeof item.variant_names === "string"
            ? [item.variant_names]
            : [];
    names.push(...variants.filter(Boolean));
    for (const name of names) {
      const key = normalizeSearch(name);
      if (!key) continue;
      if (!map.has(key)) map.set(key, item);
    }
  }
  return map;
}

function expandConjunctions(s) {
  return s.replace(
    /(.+?)\s*&\s*(.+?)\s+blueprints?/gi,
    (_, a, b) => `${a} blueprint; ${b} blueprint`
  );
}

// Position of `key` in normalized `text` as whole words only ("rope" must not match "europe").
function indexOfWord(text, key, from = 0) {
  let pos = text.indexOf(key, from);
  while (pos !== -1) {
    const before = pos === 0 ? " " : text[pos - 1];
    const after = text[pos + key.length] ?? " ";
    if (before === " " && after === " ") return pos;
    pos = text.indexOf(key, pos + 1);
  }
  return -1;
}

function findMatches(text, index) {
  let working = normalize(text);
  const matches = [];

  for (const entry of index) {
    const pos = indexOfWord(working, entry.key);
    if (pos !== -1) {
      matches.push({ entry, pos });
      working =
        working.slice(0, pos) +
        " ".repeat(entry.key.length) +
        working.slice(pos + entry.key.length);
    }
  }

  matches.sort((a, b) => a.pos - b.pos);
  return matches.map((m) => ({ ...m.entry, pos: m.pos }));
}

// Optimal string alignment distance (Levenshtein + adjacent swaps), stops early past `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur.push(d);
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

// Typos in item names ("pneumatic acurator x8"): returns the text with the name replaced by the
// closest known name, or null when nothing is close enough or two different items tie.
function fuzzyCorrect(text, index) {
  const norm = normalize(text);
  const name = norm
    .replace(/\bx\s*\d+[km]?\b|\b\d+[km]?\s*x\b|\b\d+[km]?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length < 6 || !norm.includes(name)) return null;
  const max = name.length >= 12 ? 2 : 1;
  let best = null;
  let bestDist = max + 1;
  let tie = false;
  for (const entry of index) {
    if (entry.rank !== 0) continue;
    const d = editDistance(name, entry.key, max);
    if (d < bestDist) {
      best = entry;
      bestDist = d;
      tie = false;
    } else if (d === bestDist && best && best.item.id !== entry.item.id) {
      tie = true;
    }
  }
  if (!best || tie || bestDist > max) return null;
  return norm.replace(name, best.key);
}

function isBlueprintItem(item) {
  return Boolean(item) && (item.item_type === "Blueprint" || / blueprint$/i.test(item.name || ""));
}

const ROMAN_TIER = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };

// "Stiletto Blueprint" -> the Stiletto weapon itself (highest tier when tiered: Stiletto IV).
function getItemForBlueprint(bp) {
  if (!state.blueprintTargets) state.blueprintTargets = new Map();
  if (state.blueprintTargets.has(bp.id)) return state.blueprintTargets.get(bp.id);
  const base = normalize(bp.name).replace(/\bblueprint\b/g, "").replace(/\s+/g, " ").trim();
  let best = null;
  let bestTier = -1;
  for (const it of state.items || []) {
    if (isBlueprintItem(it) || it.amp_base) continue;
    const norm = normalize(it.name);
    const stripped = norm.replace(/\b(rifle|shotgun|pistol|smg|lmg|sniper|marksman|launcher)\b/g, "").replace(/\s+/g, " ").trim();
    let tier = -1;
    if (norm === base || stripped === base) tier = 0;
    const m = norm.match(/^(.*) (i|ii|iii|iv|v)$/);
    if (m && (m[1] === base || m[1].replace(/\b(rifle|shotgun|pistol|smg|lmg)\b/g, "").trim() === base)) {
      tier = ROMAN_TIER[m[2]];
    }
    if (tier > bestTier) {
      best = it;
      bestTier = tier;
    }
  }
  state.blueprintTargets.set(bp.id, best);
  return best;
}

// Amplified weapons: items.json has one item per mod combination (amp_base + amp_mods).
function prepareAmplified(items) {
  const variants = new Map();
  const modAliases = new Map();
  for (const it of items) {
    if (!it.amp_base || !Array.isArray(it.amp_mods)) continue;
    if (!variants.has(it.amp_base)) variants.set(it.amp_base, []);
    variants.get(it.amp_base).push(it);
    for (const mod of it.amp_mods) {
      if (modAliases.has(mod)) continue;
      const aliases = new Set([mod, mod.replace(/ /g, "")]);
      for (const a of AMP_MOD_EXTRA_ALIASES[mod] || []) aliases.add(normalize(a));
      modAliases.set(mod, [...aliases].sort((a, b) => b.length - a.length));
    }
  }
  state.ampVariants = variants;
  state.ampModAliases = modAliases;
}

// Canonical mods mentioned in normalized text, limited to `allowed` when given.
function detectAmpMods(normText, allowed = null) {
  let working = ` ${normText} `;
  const found = [];
  const entries = [];
  for (const [mod, aliases] of state.ampModAliases || []) {
    if (allowed && !allowed.has(mod)) continue;
    for (const alias of aliases) entries.push({ mod, alias });
  }
  entries.sort((a, b) => b.alias.length - a.alias.length);
  for (const { mod, alias } of entries) {
    const pos = indexOfWord(working, alias);
    if (pos === -1) continue;
    if (!found.includes(mod)) found.push(mod);
    working = working.slice(0, pos) + " ".repeat(alias.length) + working.slice(pos + alias.length);
  }
  return { mods: found, rest: working.replace(/\s+/g, " ").trim() };
}

// True when a chunk only lists amplified mods ("Charged Burst)", "Sprint Shooting x2").
function isAmpModsOnly(text) {
  if (!state.ampModAliases?.size) return false;
  const norm = normalize(text);
  if (!norm) return false;
  const { mods, rest } = detectAmpMods(norm);
  if (!mods.length) return false;
  return !rest.replace(/\b(with|and|mods?|x\s*\d+|\d+\s*x?)\b/g, " ").trim();
}

// Picks the exact amplified variant for the mods written after "Amplified <weapon>".
function resolveAmplified(found, normText) {
  if (!state.ampVariants?.size) return found;
  const ampEntries = found.filter((f) => f.item?.amp_base);
  if (!ampEntries.length) return found;
  const out = [];
  const consumed = [];
  for (const f of found) {
    if (!f.item?.amp_base) continue;
    const next = ampEntries.find((a) => a.pos > f.pos);
    const segment = normText.slice(f.pos, next ? next.pos : normText.length);
    const variants = state.ampVariants.get(f.item.amp_base) || [f.item];
    const allowed = new Set(variants.flatMap((v) => v.amp_mods));
    const tail = segment.slice(normalize(`amplified ${f.item.amp_base}`).length);
    const { mods, rest } = detectAmpMods(tail, allowed);
    const unknownMods = detectAmpMods(rest).mods;
    const wanted = new Set(mods);
    let best = null;
    for (const v of variants) {
      if (!v.amp_mods.every((m) => wanted.has(m))) continue;
      if (!best || v.amp_mods.length > best.amp_mods.length) best = v;
    }
    best = best || variants.find((v) => !v.amp_mods.length) || f.item;
    const missing = [...mods.filter((m) => !best.amp_mods.includes(m)), ...unknownMods];
    const qtyMatch = segment.match(/\bx\s*(\d+)\b/);
    out.push({
      ...f,
      item: best,
      ampQty: qtyMatch ? parseInt(qtyMatch[1], 10) : null,
      note: missing.length ? `Mods not found: ${missing.join(", ")}` : undefined,
    });
    consumed.push({ from: f.pos, to: f.pos + segment.length, allowed });
  }
  // Drop items that are really mod names inside an amplified segment (e.g. "Anvil Splitter").
  return found
    .map((f) => (f.item?.amp_base ? out.shift() : f))
    .filter((f) => {
      if (f.item?.amp_base) return true;
      const seg = consumed.find((c) => f.pos >= c.from && f.pos < c.to);
      return !seg || !detectAmpMods(f.key, seg.allowed).mods.length;
    });
}

function qtyFromText(nameNorm, normText, defaultQty) {
  const idx = normText.indexOf(nameNorm);
  if (idx === -1) return defaultQty;

  const tail = normText.slice(idx + nameNorm.length, idx + nameNorm.length + 24);
  const m1 = tail.match(/x\s*(\d+)/i);
  if (m1) return parseInt(m1[1], 10);

  const head = normText.slice(Math.max(0, idx - 16), idx);
  const m1b = head.match(/x\s*(\d+[km]?)\s*$/i);
  if (m1b) return parseQtyToken(m1b[1]);
  const m2 = head.match(/(\d+[km]?)\s*$/i);
  if (m2) return parseQtyToken(m2[1]);

  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namePattern = escapeRegex(nameNorm).replace(/\s+/g, "\\s+");
  const m0 = normText.match(
    new RegExp(
      `(\\d+[km]?)\\s*x\\s*${namePattern}\\b`,
      "i",
    ),
  );
  if (m0) return parseQtyToken(m0[1]);
  const m3 = normText.match(
    new RegExp(
      `(\\d+[km]?)\\s+(?:common|uncommon|rare|epic|legendary)\\s+${namePattern}\\b`,
      "i",
    ),
  );
  if (m3) return parseQtyToken(m3[1]);

  return defaultQty;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Service orders (leveling, raids, unlocks): returns a meta entry or null.
function parseServiceChunk(text) {
  const t = text.replace(/[,.;]+$/, "").trim();
  if (!t) return null;
  // Pro for Hire: "Number of pros: 2 PROs", "Number of hours: 1" (merged into one badge in parseLine).
  const pros = t.match(/^(?:number|num|no\.?|nº)\s*of\s*pros?\s*:\s*(\d+)/i);
  if (pros) return { type: "pro-hire", pros: parseInt(pros[1], 10) };
  const hours = t.match(/^(?:number|num|no\.?|nº)\s*of\s*hours?\s*:\s*(\d+(?:\.\d+)?)/i);
  if (hours) return { type: "pro-hire", hours: Number(hours[1]) };
  // Bench mode markers are handled by parseLine itself.
  if (/^(specific\s+bench|0\s*to\s*max)/i.test(t)) return null;
  // "Add Research Station 1-4 leveling" (number before "leveling")
  const lvlAfter = t.match(/^(?:add\s+)?(research\s+station|outpost)\s+(\d+)\s*-\s*(\d+)\s+level(?:l)?ing$/i);
  if (lvlAfter) {
    const isOutpost = /outpost/i.test(lvlAfter[1]);
    return {
      type: "bench",
      benchId: isOutpost ? "outpost" : "research-station",
      benchLabel: isOutpost ? "Outpost" : "Research Station",
      mode: "specific",
      current: parseInt(lvlAfter[2], 10),
      desired: parseInt(lvlAfter[3], 10),
      price: null,
    };
  }
  // "Gunsmith workshop leveling 1 - 3" (add-on in item orders)
  const benchLvl = t.match(/^(.+?)\s+(?:workshop\s+)?level(?:l)?ing\s*:?\s*(\d+)\s*(?:-|to|→)\s*(\d+)$/i);
  const lvlBench = benchLvl ? BENCH_CATALOG.find((b) => b.aliases.includes(normalize(benchLvl[1]))) : null;
  if (lvlBench) {
    return {
      type: "bench",
      benchId: lvlBench.id,
      benchLabel: lvlBench.label,
      mode: "specific",
      current: parseInt(benchLvl[2], 10),
      desired: parseInt(benchLvl[3], 10),
      price: null,
    };
  }
  const lvl = t.match(LEVELING_TARGET_RE);
  if (lvl) {
    const name = lvl[1]
      .replace(/\s+/g, " ")
      .replace(/^oupost$/i, "outpost")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const nums = (lvl[2] || "").match(/\d+/g) || [];
    // Research Station / Outpost are stations like Gunsmith: show them as bench badges.
    if (/^(research station|outpost)$/i.test(name) && nums.length) {
      const current = nums.length >= 2 ? parseInt(nums[0], 10) : null;
      const desired = parseInt(nums[nums.length >= 2 ? 1 : 0], 10);
      return {
        type: "bench",
        benchId: name.toLowerCase().replace(/ /g, "-"),
        benchLabel: name,
        mode: "specific",
        current,
        desired,
        price: null,
      };
    }
    if (nums.length >= 2) return { type: "leveling", text: `${name} ${nums[0]}→${nums[1]}` };
    if (nums.length === 1) return { type: "leveling", text: `${name} →${nums[0]}` };
    // "ARC Raiders Outpost Upgrade" + "Full 1-4 leveling": the range belongs to this station.
    const subject = /^(research station|outpost)$/i.test(name) ? name.toLowerCase().replace(/ /g, "-") : null;
    return { type: "option", text: t, subject };
  }
  // "from 1 to 4", "1-4", "Full 1-4 leveling", "1-4 Leveling"
  const range = t.match(/^(?:from\s+|full\s+)?(\d+)\s*(?:-|to|→)\s*(\d+)(?:\s+level(?:l)?ing)?$/i);
  if (range) {
    return {
      type: "leveling",
      text: `${range[1]}→${range[2]}`,
      from: parseInt(range[1], 10),
      to: parseInt(range[2], 10),
    };
  }
  const colonIdx = t.indexOf(":");
  if (colonIdx !== -1) {
    const labelRaw = t.slice(0, colonIdx).trim();
    const label = labelRaw.toLowerCase();
    const value = t.slice(colonIdx + 1).trim();
    if (!SERVICE_LABELS.has(label)) return null;
    // "Research station: Research Station unlocked + level 4"
    const stationLevel = value.match(/\blevel\s*(\d+)/i);
    if ((label === "research station" || label === "outpost") && stationLevel) {
      const benchLabel = label === "outpost" ? "Outpost" : "Research Station";
      return {
        type: "bench",
        benchId: label.replace(/ /g, "-"),
        benchLabel,
        mode: "specific",
        current: /\bunlock/i.test(value) ? 0 : null,
        desired: parseInt(stationLevel[1], 10),
        price: null,
      };
    }
    const m = value.match(/^(\d+)\s*(?:-|to|→)\s*(\d+)$/);
    if (m && (label === "leveling" || label === "levelling")) {
      return { type: "leveling", text: `${m[1]}→${m[2]}` };
    }
    return { type: "option", text: value ? `${labelRaw}: ${value}` : labelRaw };
  }
  if (/^self[\s-]?play\b/i.test(t)) return { type: "delivery", text: t };
  if (/^(super\s+)?express$/i.test(t)) return { type: "extras", text: t };
  if (REGION_RE.test(t)) return { type: "option", text: `Region: ${t.toUpperCase()}` };
  if (
    /\b(unlock(?:ed)?|custom\s+range|leveling|levelling|upgrade)\b/i.test(t) &&
    /\b(outpost|research\s+station|workshop|station|stages?|bench)\b/i.test(t)
  ) {
    return { type: "option", text: t };
  }
  return null;
}

// options.title: the order card title ("ARC Raiders Bantam", "Items") gives context for bare names.
function parseLine(line, index, options = {}) {
  if (!line || !line.trim()) return [];
  const titleName = String(options.title || "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/^arc\s+raiders\s+/i, "")
    .replace(/\s+for\s+sale$/i, "")
    .trim();
  // In item/weapon shop orders a bare weapon name ("Stiletto") is the weapon, not its blueprint.
  const preferItems = /\b(items?|weapons?|equipment|loadouts?)\b/i.test(titleName) && !/blueprint/i.test(titleName);

  // Keep "(Bigger Mag, Charged Burst)" in one chunk: commas inside parentheses are not separators.
  let s = line.replace(
    /\(([^()]*)\)/g,
    (m, inner) => `(${inner.replace(/\s*[,+&]\s*|\s+and\s+/gi, " ")})`,
  );
  s = expandConjunctions(s);
  s = s.replace(/\n+/g, ";").replace(/\/{2,}/g, ";");
  s = s.replace(/\s*\|\|?\s*/g, ";").replace(/\s+\/\s+/g, ";");
  // "1xRadial Press" / "x1Frigate Inductor" -> separate quantity from the name.
  s = s.replace(/\b(\d+)x(?=[a-z])/gi, "$1x ").replace(/\bx(\d+)(?=[a-z])/gi, "x$1 ");
  s = s.replace(/\((\d+)\)/g, " x$1");
  s = s.replace(/\bheavey\b/gi, "heavy");
  // "Conduit Key Blue Print" -> "Conduit Key Blueprint" (otherwise "Items" orders resolve it to the key itself).
  s = s.replace(/\bblue\s+print(s?)\b/gi, "Blueprint$1");
  s = s.replace(/\bBPs?\s*:/gi, "Blueprints:");
  s = s.replace(/\bBPs?\b/gi, "Blueprints");
  s = s.replace(/\bbps?\b/gi, "blueprint");
  s = s.replace(/\bBlueprints\b(?!\s*:|\s+transfer\b)/gi, "blueprint");
  s = s.replace(
    /\b(light|medium|heavy|heavey|complex)\s+and\s+(light|medium|heavy|heavey|complex)\s+gun\s+parts\b/gi,
    (m, a, b) => `${a} gun parts, ${b} gun parts`,
  );
  s = s.replace(/\s+and\s+/gi, ", ");
  s = s.replace(
    /\bgun\s+parts\s+(?=(light|medium|heavy|heavey|complex)\b)/gi,
    "gun parts, ",
  );
  s = s.replace(
    /((?:\d+\s+)?[a-z0-9'’\-\\s]+(?:,\s*(?:\d+\s+)?[a-z0-9'’\-\\s]+)+)\s+blueprint\b/gi,
    (m, list) => {
      const items = list.split(/,\s*/).filter(Boolean);
      if (!items.length) return m;
      return items.map((it) => `${it.trim()} blueprint`).join("; ");
    },
  );
  s = s.replace(/\bblueprint\b\s+(?!x\s*\d)(?=[a-z0-9])/gi, "blueprint; ");
  s = s.replace(/Blueprints\s*:\s*([^;]+)/gi, (m, list) => {
    const items = list.split(/,\s*/).filter(Boolean);
    if (items.length <= 1) return `Blueprints: ${list}`;
    return items.map((it) => `Blueprints: ${it.trim()}`).join("; ");
  });
  s = s.replace(/Parts?\s*:\s*([^;]+)/gi, (m, list) => {
    const items = list.split(/,\s*/).filter(Boolean);
    if (items.length <= 1) return `Parts: ${list}`;
    return items.map((it) => `Parts: ${it.trim()}`).join("; ");
  });
  s = s.replace(/,\s+/g, (match, offset, str) => {
    const prev = str[offset - 1];
    const next = str[offset + match.length];
    if (/\d/.test(prev) && /\d/.test(next)) return match;
    return "; ";
  });

  let defaultQty = 1;
  let qtyMultiplier = 1;
  let packMultiplier = 1;
  let mode = null;
  const each = s.match(/(?:no\.?|nº)\s*of\s*each\s*item\s*:\s*(\d+)/i);
  if (each) defaultQty = parseInt(each[1], 10);
  const qty = s.match(/quantity\s*:\s*(\d+)/i);
  if (qty) qtyMultiplier = parseInt(qty[1], 10);
  const loadouts = s.match(/number\s*of\s*loadouts\s*:\s*(\d+)/i);
  if (loadouts) qtyMultiplier = parseInt(loadouts[1], 10);
  const packs = s.match(
    /(?:no\.?|nº|number|num)\s*of\s*[a-z ]*packs?\s*:\s*(\d+)/i,
  );
  if (packs) packMultiplier = parseInt(packs[1], 10);

  s = s.replace(/(?:no\.?|nº)\s*of\s*each\s*item\s*:\s*\d+/gi, " ");
  s = s.replace(/quantity\s*:\s*\d+/gi, " ");
  s = s.replace(/number\s*of\s*loadouts\s*:\s*\d+/gi, " ");
  s = s.replace(
    /(?:no\.?|nº|number|num)\s*of\s*[a-z ]*packs?\s*:\s*\d+/gi,
    " ",
  );

  const parts = s
    .split(";")
    .flatMap((p) => {
      const label = (p.match(/^([^:]{1,40}):/)?.[1] || "").trim().toLowerCase();
      if (NO_PLUS_SPLIT_LABELS.has(label) || META_LABELS.has(label) || SERVICE_LABELS.has(label)) return [p];
      return p.split(/\s+\+\s+(?!(?:level|lvl)\b)/i);
    })
    .map((p) => p.trim())
    .filter(Boolean);

  const out = [];
  // Re-attach amplified mods that were split off: "Amplified Rascal with Sprint Shooting; Incendiary Grenades".
  const chunks = [];
  for (const p of parts.length ? parts : [s]) {
    const prev = chunks[chunks.length - 1];
    if (prev && /\bamplified\b/.test(normalize(prev)) && isAmpModsOnly(p)) {
      chunks[chunks.length - 1] = `${prev} ${p}`;
    } else {
      chunks.push(p);
    }
  }

  const weaponSlots = { first: [], second: [] };
  const pendingWeaponNotes = { first: [], second: [] };
  const attachWeaponNote = (slot, note) => {
    if (!note || !slot) return;
    const list = weaponSlots[slot];
    if (list.length) {
      for (const entry of list) {
        entry.note = entry.note ? `${entry.note}; ${note}` : note;
      }
      return;
    }
    pendingWeaponNotes[slot].push(note);
  };
  const parseWeaponMods = (value) => {
    const v = value.trim();
    if (!v) return null;
    const m = v.match(
      /^(.*?)\s+for\s+(?:the\s+)?(1st|2nd|first|second)\s+weapon\b/i,
    );
    if (!m) return null;
    const note = (m[1] || "").trim() || v.replace(/\s+for\s+.*$/i, "").trim();
    const slot =
      m[2].toLowerCase().startsWith("1") ||
        m[2].toLowerCase().startsWith("first")
        ? "first"
        : "second";
    return { slot, note };
  };

  // "from 1 to 4" + "Research station (custom range)" / "Add Research Station unlock" (see end of parseLine).
  let researchCustomRange = false;
  // Station a bare range refers to: from the text ("Outpost Upgrade") or the card title ("Research Station Leveling").
  let rangeSubject = /research\s+station/i.test(titleName)
    ? { id: "research-station", entry: null }
    : /outpost/i.test(titleName)
      ? { id: "outpost", entry: null }
      : null;
  const rangeEntries = [];
  const unlockStations = new Set();

  const benchState = {
    current: null,
    desired: null,
    mode: null,
    benches: new Map(),
  };
  const addBench = (bench) => {
    if (!bench || !bench.id) return;
    const prev = benchState.benches.get(bench.id) || {
      id: bench.id,
      label: bench.label,
      price: null,
      current: null,
      desired: null,
    };
    if (Number.isFinite(bench.price)) prev.price = bench.price;
    if (Number.isFinite(bench.current)) prev.current = bench.current;
    if (Number.isFinite(bench.desired)) prev.desired = bench.desired;
    benchState.benches.set(bench.id, prev);
  };

  for (const part of chunks) {
    // "1. ARC Raiders Blueprints: Platform: PC" -> "Platform: PC"
    const trimmed = part.trim().replace(/^\d+\.\s*arc\s+raiders\b[^:]*:\s*/i, "");
    if (!trimmed) continue;
    if (IGNORE_PHRASES.has(normalize(trimmed))) continue;

    if (/research\s+station\s*\(custom\s+range\)/i.test(trimmed)) researchCustomRange = true;
    for (const m of trimmed.matchAll(/(?:^|\badd\s+)(research\s+station|outpost)\s+unlock\b/gi)) {
      unlockStations.add(/outpost/i.test(m[1]) ? "outpost" : "research-station");
    }

    // "Options: Full 1-4 leveling" carries a level range: parse the value like a service chunk.
    const optionValue = trimmed.match(/^options?\s*:\s*(.+)$/i)?.[1];
    const optionService = optionValue ? parseServiceChunk(optionValue) : null;
    const service =
      optionService && (optionService.type === "bench" || Number.isFinite(optionService.from))
        ? optionService
        : parseServiceChunk(trimmed);
    if (service) {
      const entry = { meta: service };
      if (Number.isFinite(service.from)) rangeEntries.push(entry);
      if (service.subject) rangeSubject = { id: service.subject, entry };
      out.push(entry);
      mode = null;
      continue;
    }

    let text = trimmed;
    let weaponSlot = null;

    const inlineBenches = extractBenchesFromText(trimmed);
    if (inlineBenches.length) {
      inlineBenches.forEach(addBench);
      if (!benchState.mode) benchState.mode = "max";
    }

    // "Blueprints for" / "Materials of" are list headers, not item names.
    const isHeader = (rest) => /^(?:for|of|to|list|needed|wanted)?\s*:?$/i.test(rest.trim());
    const bpInline = trimmed.match(/^blueprints?\s+(.+)$/i);
    if (bpInline && isHeader(bpInline[1])) {
      mode = "blueprint";
      continue;
    }
    if (bpInline) {
      mode = "blueprint";
      text = bpInline[1].trim();
    } else if (/^blueprints?$/i.test(trimmed.replace(/:$/, ""))) {
      mode = "blueprint";
      continue;
    }
    const matInline = trimmed.match(/^materials?\s+(.+)$/i);
    if (matInline && isHeader(matInline[1])) {
      mode = "materials";
      continue;
    }
    if (matInline) {
      mode = "materials";
      text = matInline[1].trim();
    } else if (/^materials?$/i.test(trimmed.replace(/:$/, ""))) {
      mode = "materials";
      continue;
    }

    const colonIdx = trimmed.indexOf(":");

    let chunkLabel = null;
    if (colonIdx !== -1) {
      const labelRaw = trimmed.slice(0, colonIdx).trim();
      const label = labelRaw.toLowerCase();
      // "Cmpletion Speed:: Express" -> value "Express"
      const value = trimmed.slice(colonIdx + 1).replace(/^[:\s]+/, "").trim();
      chunkLabel = { raw: labelRaw, label, value };

      if (/^c(?:o)?mpletions?\s+speed$/.test(label)) {
        if (value) out.push({ meta: { type: "delivery", text: value } });
        mode = null;
        continue;
      }
      if (/^none$/i.test(value)) continue;
      // Weapon bundles: "Crafting materials: 5 guns" / "Upgrade materials: 5 guns" (weapon resolved at the end).
      if (label === "crafting materials" || label === "upgrade materials") {
        const guns = value.match(/(\d+)/);
        out.push({
          meta: {
            type: "craft",
            kind: label.startsWith("crafting") ? "craft" : "upgrade",
            guns: guns ? parseInt(guns[1], 10) : 1,
            weapon: null,
          },
        });
        mode = null;
        continue;
      }
      if (label === "number of weapons" || label === "no. of weapons") {
        const m = value.match(/(\d+)/);
        if (m) defaultQty = parseInt(m[1], 10);
        continue;
      }
      // Workshop sliders: "Workshop Bench Leveling: 2 Current level-4 Desired level", "Scrappy Level: 1 ...-3 ..."
      const levelNums = value.match(/\d+/g) || [];
      if (/\blevel(?:l?ing)?$/.test(label) && levelNums.length >= 2) {
        const sliderBench = findBenchInText(label);
        if (sliderBench) {
          addBench({ ...sliderBench, current: parseInt(levelNums[0], 10), desired: parseInt(levelNums[1], 10) });
          continue;
        }
        if (/^workshop\s+bench\s+level/.test(label)) {
          benchState.current = parseInt(levelNums[0], 10);
          benchState.desired = parseInt(levelNums[1], 10);
          continue;
        }
      }
      // Weapon shop sliders: "Aphelion (Weapon): 3 Weapons", "Bantam (Tier IV): 2 Weapons"
      const weaponSlider = labelRaw.match(/^(.+?)\s*\((weapon|tier\s*iv)\)$/i);
      if (weaponSlider) {
        const qtyMatch = value.match(/(\d+)/);
        const tier = /tier/i.test(weaponSlider[2]) ? " IV" : "";
        text = `${weaponSlider[1]}${tier} x${qtyMatch ? qtyMatch[1] : 1}`;
        mode = null;
      }
      // "Number of Items: 8 Number of Items" on "ARC Raiders Snap Hook for Sale": the item is in the title.
      const itemsSlider =
        label === "number of items" && titleName && /\d/.test(value) && findMatches(titleName, index).length > 0;
      if (itemsSlider) {
        text = `${titleName} x${value.match(/\d+/)[0]}`;
        mode = null;
      }
      // "Options: Blueprint" on "ARC Raiders Canto for Sale" means the Canto blueprint.
      if ((label === "options" || label === "option") && /^blueprint$/i.test(value) && titleName) {
        text = `${titleName} blueprint`;
        mode = null;
      }

      if (label === "blueprints") {
        mode = "blueprint";
        if (!value) continue;
        text = `${value} blueprint`;
      }
      if (label === "bp" || label === "bps") {
        mode = "blueprint";
        if (!value) continue;
        text = `${value} blueprint`;
      }
      if (label === "materials") {
        mode = "materials";
        if (!value) continue;
        text = value;
      }
      if (label === "weapons" || label === "weapon") {
        mode = null;
        if (!value) continue;
        text = value;
      }
      if (label === "parts" || label === "part") {
        mode = null;
        if (!value) continue;
        text = value;
      }
      if (label === "current level") {
        const m = value.match(/(\d+)/);
        if (m) benchState.current = parseInt(m[1], 10);
        mode = null;
        continue;
      }
      if (label === "desired level") {
        const m = value.match(/(\d+)/);
        if (m) benchState.desired = parseInt(m[1], 10);
        mode = null;
        continue;
      }
      if (label === "bench") {
        const benches = extractBenchesFromText(value);
        if (benches.length) benches.forEach(addBench);
        mode = null;
        continue;
      }
      if (label.startsWith("what should we level up")) {
        if (/0\s*to\s*max/i.test(value)) {
          benchState.mode = "max";
        } else if (/specific\s+bench/i.test(value)) {
          benchState.mode = "specific";
        } else {
          const benches = extractBenchesFromText(value);
          if (benches.length) {
            benches.forEach(addBench);
            benchState.mode = "single";
          }
        }
        mode = null;
        continue;
      }
      if (label === "platform") {
        const v = value.toLowerCase();
        let platform = null;
        if (v.includes("playstation") || v.includes("psn") || v.includes("ps4") || v.includes("ps5")) {
          platform = "playstation";
        } else if (v.includes("xbox")) {
          platform = "xbox";
        } else if (v.includes("pc")) {
          platform = "pc";
        }
        if (platform) {
          out.push({ meta: { type: "platform", platform, text: value } });
        }
        mode = null;
        continue;
      }

      if (label === "delivery method" || label === "delivery") {
        if (value) {
          out.push({ meta: { type: "delivery", text: value } });
        }
        mode = null;
        continue;
      }
      if (label === "completion speed") {
        if (value) {
          out.push({ meta: { type: "delivery", text: value } });
        }
        mode = null;
        continue;
      }
      if (label === "completions speed") {
        if (value) {
          out.push({ meta: { type: "delivery", text: value } });
        }
        mode = null;
        continue;
      }
      if (label === "boosting options") {
        if (value) {
          out.push({ meta: { type: "boosting", text: value } });
        }
        mode = null;
        continue;
      }
      if (label === "completion method") {
        if (value) {
          out.push({ meta: { type: "delivery", text: value } });
        }
        mode = null;
        continue;
      }
      if (label === "extras") {
        if (value) {
          out.push({ meta: { type: "extras", text: value } });
        }
        mode = null;
        continue;
      }
      if ((label === "options" || label === "option") && !(/^blueprint$/i.test(value) && titleName)) {
        const benches = extractBenchesFromText(value);
        if (benches.length) {
          benches.forEach(addBench);
          benchState.mode = benchState.mode || "max";
          mode = null;
          continue;
        }
        if (value) {
          out.push({ meta: { type: "option", text: value } });
        }
        mode = null;
        continue;
      }
      if (
        label === "blueprints transfer" ||
        label === "blueprint transfer" ||
        label === "transfer blueprints" ||
        label === "transfer blueprint"
      ) {
        if (value) {
          out.push({ meta: { type: "blueprints-transfer", text: value } });
        }
        mode = null;
        continue;
      }
      if (label === "inventory slots to transfer") {
        const m = value.match(/(\d+)/);
        if (m) {
          out.push({
            meta: { type: "mule", qty: parseInt(m[1], 10) },
          });
        }
        mode = null;
        continue;
      }
      if (label === "weapon mods") {
        const mods = parseWeaponMods(value || "");
        if (mods && mods.note) attachWeaponNote(mods.slot, mods.note);
        mode = null;
        continue;
      }
      if (label === "first weapon") {
        mode = null;
        if (!value) continue;
        weaponSlot = "first";
        text = value;
      }
      if (label === "second weapon") {
        mode = null;
        if (!value) continue;
        weaponSlot = "second";
        text = value;
      }
      if (META_LABELS.has(label)) {
        mode = null;
        continue;
      }

      if (weaponSlider || itemsSlider || (label === "options" && /^blueprint$/i.test(value) && titleName)) {
        // text already set above
      } else if (LABEL_NAME_SUFFIX[label]) {
        // Keep a trailing quantity after the name: "Windsprite x6" -> "Windsprite ship model x6"
        text = value.replace(/(\s*x\s*\d+)?\s*$/i, ` ${LABEL_NAME_SUFFIX[label]}$1`).trim();
      } else if (/blueprint/.test(label)) {
        text = `${value} blueprint`;
      } else if (/materials?/.test(label)) {
        text = value;
      } else if (/packs?/.test(label)) {
        text = value;
      } else if (/coins?/.test(label)) {
        text = value;
      } else {
        text = value ? `${label} ${value}`.trim() : label;
      }
    }

    if (/^0\s*to\s*max\s*level/i.test(trimmed)) {
      benchState.mode = "max";
      continue;
    }
    if (/^specific\s+bench/i.test(trimmed)) {
      benchState.mode = "specific";
      continue;
    }

    if (mode === "blueprint" && !/coins?/i.test(text)) {
      if (!/blueprint/i.test(text)) {
        text = `${text} blueprint`;
      }
    }

    const orderRegex =
      /(\d+)\s*order\s*of\s*([a-z0-9'’\-\\s]+?)\s*x\s*(\d+)/i;
    let orderMatch = orderRegex.exec(text);
    while (orderMatch) {
      const count = parseInt(orderMatch[1], 10);
      const per = parseInt(orderMatch[3], 10);
      const name = orderMatch[2].trim();
      const total = (Number.isFinite(count) ? count : 1) *
        (Number.isFinite(per) ? per : 1);
      const foundOrders = findMatches(name, index);
      if (foundOrders.length) {
        for (const f of foundOrders) {
          out.push({ raw: name, qty: total, item: f.item });
        }
      } else {
        out.push({ raw: name, qty: total, item: null });
      }
      text = text.replace(orderMatch[0], " ").trim();
      if (!text) break;
      orderMatch = orderRegex.exec(text);
    }
    if (!text) {
      mode = null;
      continue;
    }

    if (/piloted\s+only/i.test(text)) {
      continue;
    }
    const pilotedMatch = text.match(/\bpiloted\b/i);
    if (pilotedMatch) {
      out.push({ meta: { type: "delivery", text: "Piloted" } });
      text = text.replace(/\bpiloted\b/gi, " ").trim();
      if (!text) {
        mode = null;
        continue;
      }
    }

    let coinHandled = false;
    const coinWordMatch = text.match(
      /(\d+(?:\.\d+)?)\s*million\s*coins?\b/i,
    );
    if (coinWordMatch) {
      const qty = Math.round(
        parseFloat(coinWordMatch[1]) * 1000000,
      );
      out.push({
        raw: coinWordMatch[0],
        qty: qty * qtyMultiplier * packMultiplier,
        item: state.itemById?.get("arc-coins") ?? null,
      });
      text = text.replace(coinWordMatch[0], " ").trim();
      coinHandled = true;
      mode = null;
    }

    const coinMatch =
      text.match(/(\d+[kKmM]?)\s*coins?\b/i) ||
      (coinHandled ? null : text.match(/\bcoins?\s*:?\s*(\d+[kKmM]?)\b/i));
    if (coinMatch) {
      const qtyToken = coinMatch[1];
      const qty = (parseQtyToken(qtyToken) ?? defaultQty) * qtyMultiplier * packMultiplier;
      out.push({
        raw: coinMatch[0],
        qty,
        item: state.itemById?.get("arc-coins") ?? null,
      });
      text = text.replace(coinMatch[0], " ").trim();
      coinHandled = true;
      mode = null;
    }

    const normTextAll = normalize(text);
    if (normTextAll) {
      const tokens = normTextAll.split(" ").filter(Boolean);
      const onlyIgnored =
        tokens.length > 0 && tokens.every((t) => IGNORE_TOKENS.has(t));
      if (onlyIgnored) {
        const platform = tokens.some((t) => ["playstation", "psn", "ps4", "ps5", "ps"].includes(t))
          ? "playstation"
          : tokens.includes("xbox")
            ? "xbox"
            : tokens.includes("pc")
              ? "pc"
              : null;
        if (platform && !out.some((e) => e.meta?.type === "platform")) {
          out.push({ meta: { type: "platform", platform, text } });
        }
        continue;
      }
      if (IGNORE_PHRASES.has(normTextAll)) {
        continue;
      }
    }

    let found = resolveAmplified(findMatches(text, index), normalize(text));
    if (!found.length && !coinHandled && (!chunkLabel || ITEM_LABEL_RE.test(chunkLabel.label))) {
      const corrected = fuzzyCorrect(text, index);
      if (corrected) {
        text = corrected;
        found = resolveAmplified(findMatches(text, index), normalize(text));
      }
    }
    if (!found.length) {
      if (!coinHandled && text) {
        if (findBenchInText(text) || /\blvl\s*\d+/i.test(text)) {
          mode = null;
          continue;
        }
        // Service fields ("Raid mode: Night Raid", "Current rank: Wildcard II") are not items.
        if (chunkLabel && chunkLabel.value && !ITEM_LABEL_RE.test(chunkLabel.label)) {
          out.push({ meta: { type: "option", text: `${chunkLabel.raw}: ${chunkLabel.value}` } });
          mode = null;
          continue;
        }
        if (/^add\s+\S/i.test(trimmed)) {
          out.push({ meta: { type: "option", text: trimmed } });
          continue;
        }
        const entry = { raw: part.trim(), qty: defaultQty, item: null };
        out.push(entry);
      }
      continue;
    }

    const normText = normalize(text);
    for (const f of found) {
      const baseQty = f.ampQty ?? qtyFromText(f.key, normText, defaultQty);
      const q = baseQty * qtyMultiplier * packMultiplier;
      let item = f.item;
      if (preferItems && mode !== "blueprint" && !/blueprint/i.test(text) && isBlueprintItem(item)) {
        item = getItemForBlueprint(item) || item;
      }
      const entry = { raw: part.trim(), qty: q, item };
      if (f.note) entry.note = f.note;
      if (weaponSlot) {
        const pending = pendingWeaponNotes[weaponSlot];
        if (pending && pending.length) {
          entry.note = pending.join("; ");
          pending.length = 0;
        }
        weaponSlots[weaponSlot].push(entry);
      }
      out.push(entry);
    }
  }

  // A bare level range belongs to the bench the order is about.
  if (rangeEntries.length === 1) {
    const range = rangeEntries[0].meta;
    let applied = false;
    const stationId = researchCustomRange ? "research-station" : rangeSubject?.id;
    if (stationId && !out.some((e) => e.meta?.benchId === stationId)) {
      out.push({
        meta: {
          type: "bench",
          benchId: stationId,
          benchLabel: stationId === "outpost" ? "Outpost" : "Research Station",
          mode: "specific",
          current: range.from,
          desired: range.to,
          price: null,
        },
      });
      // The "ARC Raiders Outpost Upgrade" label is now part of the bench badge.
      if (rangeSubject?.entry && !researchCustomRange) out.splice(out.indexOf(rangeSubject.entry), 1);
      applied = true;
    } else if (
      benchState.benches.size === 1 &&
      benchState.current === null &&
      benchState.desired === null
    ) {
      benchState.current = range.from;
      benchState.desired = range.to;
      applied = true;
    }
    if (applied) out.splice(out.indexOf(rangeEntries[0]), 1);
  }

  if (
    benchState.current !== null ||
    benchState.desired !== null ||
    benchState.benches.size
  ) {
    const fromGlobal = Number.isFinite(benchState.current) ? benchState.current : null;
    const toGlobal = Number.isFinite(benchState.desired) ? benchState.desired : null;
    if (benchState.benches.size) {
      for (const bench of benchState.benches.values()) {
        const from = Number.isFinite(bench.current) ? bench.current : fromGlobal;
        const to = Number.isFinite(bench.desired) ? bench.desired : toGlobal;
        let mode = benchState.mode;
        if (!Number.isFinite(to) && !mode && Number.isFinite(from)) {
          mode = "max";
        }
        out.push({
          meta: {
            type: "bench",
            benchId: bench.id,
            benchLabel: bench.label,
            mode,
            current: from,
            desired: to,
            price: bench.price ?? null,
          },
        });
      }
    } else {
      let mode = benchState.mode;
      if (!Number.isFinite(toGlobal) && !mode && Number.isFinite(fromGlobal)) {
        mode = "max";
      }
      out.push({
        meta: {
          type: "bench",
          benchId: null,
          benchLabel: "Workbench",
          mode,
          current: fromGlobal,
          desired: toGlobal,
          price: null,
        },
      });
    }
  }

  const proEntries = out.filter((e) => e.meta?.type === "pro-hire");
  if (proEntries.length > 1) {
    const merged = Object.assign({}, ...proEntries.map((e) => e.meta));
    proEntries.slice(1).forEach((e) => out.splice(out.indexOf(e), 1));
    proEntries[0].meta = merged;
  }

  // Which weapon a bundle's crafting/upgrade materials are for: the title ("Anvil Complete Bundle")
  // or the blueprint in the same order ("Blueprint: Anvil blueprint").
  const craftEntries = out.filter((e) => e.meta?.type === "craft");
  if (craftEntries.length && state.weaponRecipes) {
    const candidates = [
      normalize(titleName),
      ...out.filter((e) => e.item).map((e) => normalize(e.item.name).replace(/\bblueprint\b/g, "").trim()),
    ];
    let weapon = null;
    for (const c of candidates) {
      weapon = Object.keys(state.weaponRecipes).find((w) => indexOfWord(c, w) !== -1);
      if (weapon) break;
    }
    for (const e of craftEntries) e.meta.weapon = weapon;
  }

  // "Add Research Station unlock": building the station (level 1) is part of the order too.
  for (const stationId of unlockStations) {
    const bench = out.find((e) => e.meta?.type === "bench" && e.meta.benchId === stationId)?.meta;
    if (bench) {
      if (!Number.isFinite(bench.current) || bench.current > 0) bench.current = 0;
    } else {
      out.push({
        meta: {
          type: "bench",
          benchId: stationId,
          benchLabel: stationId === "outpost" ? "Outpost" : "Research Station",
          mode: "specific",
          current: 0,
          desired: 1,
          price: null,
        },
      });
    }
  }

  return out;
}

