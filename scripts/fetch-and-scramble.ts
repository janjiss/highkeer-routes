/**
 * fetch-and-scramble.ts
 *
 * Downloads hiking/walking routes from OpenStreetMap via the Overpass API
 * for specified regions, applies light scrambling (coordinate jitter,
 * shifted timestamps, renamed titles), and writes GPX files to source/.
 *
 * Usage:
 *   npx tsx scripts/fetch-and-scramble.ts
 */

import * as fs from "fs";
import * as path from "path";

const OUT_DIR = path.resolve(__dirname, "..", "source");

// ── Region configs ──────────────────────────────────────────────────
interface RegionConfig {
  id: string;
  label: string;
  /** [south, west, north, east] */
  bbox: [number, number, number, number];
  target: number;
}

const REGIONS: RegionConfig[] = [
  {
    id: "aveiro",
    label: "Aveiro",
    // Aveiro district + surrounding area (wider box to get 50+)
    bbox: [40.3, -8.85, 41.1, -8.0],
    target: 55,
  },
  {
    id: "kurzeme",
    label: "Kurzeme",
    // Kurzeme region in western Latvia
    bbox: [56.3, 20.9, 57.8, 23.5],
    target: 55,
  },
];

// ── Overpass query ──────────────────────────────────────────────────

function buildOverpassQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  const bb = `${s},${w},${n},${e}`;
  // Fetch hiking/walking/foot routes as relations with their ways resolved
  return `
[out:json][timeout:120];
(
  relation["route"="hiking"](${bb});
  relation["route"="foot"](${bb});
  relation["route"="walking"](${bb});
  way["highway"~"path|footway|track"]["name"](${bb});
);
out body;
>;
out skel qt;
`.trim();
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  members?: Array<{ type: string; ref: number; role: string }>;
  nodes?: number[];
}

async function queryOverpass(
  query: string
): Promise<{ elements: OverpassElement[] }> {
  const endpoints = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const wait = 15000 * attempt;
      console.log(`  Retry ${attempt}, waiting ${wait / 1000}s …`);
      await new Promise((r) => setTimeout(r, wait));
    }
    for (const baseUrl of endpoints) {
      try {
        console.log(`  Querying ${new URL(baseUrl).hostname} …`);
        const resp = await fetch(baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "*/*",
            "User-Agent": "HighKeer-RouteBuilder/1.0",
          },
          body: "data=" + encodeURIComponent(query),
        });
        if (resp.status === 429 || resp.status === 406) {
          console.warn(`  ${new URL(baseUrl).hostname} returned HTTP ${resp.status}, trying next…`);
          continue;
        }
        if (!resp.ok) {
          console.warn(`  ${new URL(baseUrl).hostname} returned HTTP ${resp.status}, trying next…`);
          continue;
        }
        return resp.json() as Promise<{ elements: OverpassElement[] }>;
      } catch (err: any) {
        console.warn(`  ${new URL(baseUrl).hostname} failed: ${err.message}, trying next…`);
      }
    }
  }
  throw new Error("All Overpass endpoints failed after retries");
}

// ── Helpers ─────────────────────────────────────────────────────────

function sqDist(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const dlat = a.lat - b.lat;
  const dlon = a.lon - b.lon;
  return dlat * dlat + dlon * dlon;
}

// ── Resolve geometry from Overpass elements ─────────────────────────

interface RawRoute {
  name: string;
  coords: Array<{ lat: number; lon: number }>;
}

/**
 * Max gap between consecutive points (degrees²) before we consider
 * the chain broken. ~500 m ≈ 0.0045° → squared ≈ 2e-5.
 */
const MAX_GAP_SQ = 2e-5;

type Pt = { lat: number; lon: number };

/**
 * Build a chain of ways by matching endpoints greedily.
 * Returns the longest connected chain from a set of way geometries.
 */
function chainWays(
  segmentList: Pt[][]
): Pt[] {
  if (segmentList.length === 0) return [];
  if (segmentList.length === 1) return segmentList[0];

  const remaining = new Set(segmentList.map((_, i) => i));

  function bestChainFrom(startIdx: number): Pt[] {
    const used = new Set<number>();
    used.add(startIdx);
    const chain = [...segmentList[startIdx]];

    let changed = true;
    while (changed) {
      changed = false;
      let bestIdx = -1;
      let bestDist = Infinity;
      let bestReverse = false;

      const tail = chain[chain.length - 1];

      for (const idx of remaining) {
        if (used.has(idx)) continue;
        const seg = segmentList[idx];
        const dFirst = sqDist(tail, seg[0]);
        const dLast = sqDist(tail, seg[seg.length - 1]);
        const d = Math.min(dFirst, dLast);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = idx;
          bestReverse = dLast < dFirst;
        }
      }

      if (bestIdx >= 0 && bestDist < MAX_GAP_SQ) {
        used.add(bestIdx);
        const seg = [...segmentList[bestIdx]];
        if (bestReverse) seg.reverse();
        if (sqDist(tail, seg[0]) < 1e-10) seg.shift();
        chain.push(...seg);
        changed = true;
      }
    }
    return chain;
  }

  let longest: Pt[] = [];
  for (let i = 0; i < segmentList.length; i++) {
    const chain = bestChainFrom(i);
    if (chain.length > longest.length) longest = chain;
  }
  return longest;
}

/**
 * Post-process a coordinate array: split at large gaps and
 * return only the longest contiguous segment.
 */
function longestContiguousSegment(coords: Pt[]): Pt[] {
  if (coords.length < 2) return coords;
  let best: Pt[] = [];
  let current: Pt[] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    if (sqDist(coords[i - 1], coords[i]) > MAX_GAP_SQ) {
      if (current.length > best.length) best = current;
      current = [];
    }
    current.push(coords[i]);
  }
  if (current.length > best.length) best = current;
  return best;
}

function resolveRoutes(elements: OverpassElement[]): RawRoute[] {
  const nodeMap = new Map<number, Pt>();
  const ways = new Map<number, number[]>();
  const relations: OverpassElement[] = [];
  const namedWays: OverpassElement[] = [];

  for (const el of elements) {
    if (el.type === "node" && el.lat != null && el.lon != null) {
      nodeMap.set(el.id, { lat: el.lat, lon: el.lon });
    } else if (el.type === "way" && el.nodes) {
      ways.set(el.id, el.nodes);
      if (el.tags?.name) namedWays.push(el);
    } else if (el.type === "relation") {
      relations.push(el);
    }
  }

  const routes: RawRoute[] = [];

  for (const rel of relations) {
    const name = rel.tags?.name ?? `Route ${rel.id}`;

    const wayMembers = (rel.members ?? []).filter(
      (m) =>
        m.type === "way" &&
        (m.role === "" || m.role === "forward" || m.role === "main" || !m.role)
    );

    const segments: Pt[][] = [];
    for (const member of wayMembers) {
      const nodeIds = ways.get(member.ref);
      if (!nodeIds || nodeIds.length === 0) continue;
      const pts: Pt[] = [];
      for (const nid of nodeIds) {
        const pt = nodeMap.get(nid);
        if (pt) pts.push(pt);
      }
      if (pts.length >= 2) segments.push(pts);
    }

    let coords = chainWays(segments);
    coords = longestContiguousSegment(coords);

    if (coords.length >= 10) {
      routes.push({ name, coords });
    }
  }

  for (const w of namedWays) {
    const name = w.tags!.name!;
    const nodeIds = ways.get(w.id);
    if (!nodeIds) continue;
    const coords: Pt[] = [];
    for (const nid of nodeIds) {
      const pt = nodeMap.get(nid);
      if (pt) coords.push(pt);
    }
    if (coords.length >= 10) {
      routes.push({ name, coords });
    }
  }

  return routes;
}

// ── Scrambling ──────────────────────────────────────────────────────

/** Seeded PRNG (xorshift32) for reproducibility */
function makePrng(seed: number) {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

interface ScrambledPoint {
  lat: string;
  lon: string;
  ele: string;
  time: string;
}

function scrambleRoute(
  coords: Array<{ lat: number; lon: number }>,
  seed: number
): ScrambledPoint[] {
  const rng = makePrng(seed);

  // Jitter magnitude: ~5-20 m (0.00005–0.0002 degrees)
  const jitterMag = 0.00005 + rng() * 0.00015;
  // Time base: some date in 2024-2025
  const baseTime =
    new Date("2024-06-01T08:00:00Z").getTime() +
    Math.floor(rng() * 365 * 24 * 3600 * 1000);
  let elapsed = 0;

  // Estimate base elevation from latitude (rough heuristic)
  const avgLat = coords.reduce((s, c) => s + c.lat, 0) / coords.length;
  let baseEle = avgLat > 55 ? 5 + rng() * 30 : 50 + rng() * 300;
  let ele = baseEle;

  return coords.map((c, i) => {
    const jLat = (rng() - 0.5) * 2 * jitterMag;
    const jLon = (rng() - 0.5) * 2 * jitterMag;

    // Elapsed: 3-8 seconds per point with some variance
    if (i > 0) {
      elapsed += 3000 + Math.floor(rng() * 5000);
    }

    // Elevation random walk
    ele += (rng() - 0.48) * 3;
    if (ele < 0) ele = rng() * 5;

    const t = new Date(baseTime + elapsed);

    return {
      lat: (c.lat + jLat).toFixed(6),
      lon: (c.lon + jLon).toFixed(6),
      ele: ele.toFixed(1),
      time: t.toISOString().replace(/\.\d+Z$/, "Z"),
    };
  });
}

// ── GPX generation ──────────────────────────────────────────────────

function toGpx(name: string, points: ScrambledPoint[]): string {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="HighKeer Route Generator"`,
    `  xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <metadata>`,
    `    <name>${escXml(name)}</name>`,
    `    <time>${points[0]?.time ?? new Date().toISOString()}</time>`,
    `  </metadata>`,
    `  <trk>`,
    `    <name>${escXml(name)}</name>`,
    `    <trkseg>`,
  ];

  for (const p of points) {
    lines.push(`      <trkpt lat="${p.lat}" lon="${p.lon}">`);
    lines.push(`        <ele>${p.ele}</ele>`);
    lines.push(`        <time>${p.time}</time>`);
    lines.push(`      </trkpt>`);
  }

  lines.push(`    </trkseg>`);
  lines.push(`  </trk>`);
  lines.push(`</gpx>`);

  return lines.join("\n");
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── File naming ─────────────────────────────────────────────────────

function safeFileName(region: string, name: string, idx: number): string {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${region}_${String(idx).padStart(3, "0")}_${slug}.gpx`;
}

// ── Filtering ───────────────────────────────────────────────────────

const MAX_ROUTE_LENGTH_KM = 50;

const SKIP_NAME_PATTERN =
  /caminho|camino|e\d+\s*section|grande rota|1836/i;

function dedup(routes: RawRoute[]): RawRoute[] {
  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = r.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function filterRoutes(routes: RawRoute[]): RawRoute[] {
  return routes.filter((r) => {
    if (SKIP_NAME_PATTERN.test(r.name)) return false;
    const km = estimateDistKm(r.coords);
    return km <= MAX_ROUTE_LENGTH_KM && km >= 0.5;
  });
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const onlyRegion = process.argv[2]; // optional: "aveiro" or "kurzeme"

  for (let ri = 0; ri < REGIONS.length; ri++) {
    const region = REGIONS[ri];
    if (onlyRegion && region.id !== onlyRegion) {
      console.log(`Skipping ${region.label} (filter: ${onlyRegion})`);
      continue;
    }
    if (ri > 0) {
      console.log("\n  Waiting 30s to respect Overpass rate limits …");
      await new Promise((r) => setTimeout(r, 30000));
    }
    console.log(`\n=== ${region.label} (target: ${region.target} routes) ===`);

    const query = buildOverpassQuery(region.bbox);
    const data = await queryOverpass(query);
    console.log(`  Got ${data.elements.length} elements from Overpass`);

    let routes = resolveRoutes(data.elements);
    console.log(`  Resolved ${routes.length} routes with geometry`);

    routes = dedup(routes);
    console.log(`  After dedup: ${routes.length} unique routes`);

    routes = filterRoutes(routes);
    console.log(`  After filtering (<${MAX_ROUTE_LENGTH_KM}km, no pilgrimage): ${routes.length} routes`);

    // Sort by coordinate count (prefer meatier routes) and take target
    routes.sort((a, b) => b.coords.length - a.coords.length);
    const selected = routes.slice(0, region.target);

    console.log(`  Selected ${selected.length} routes for output`);

    for (let i = 0; i < selected.length; i++) {
      const route = selected[i];
      const seed = region.id.length * 1000000 + i * 7919 + route.coords.length;
      const points = scrambleRoute(route.coords, seed);
      const gpxContent = toGpx(route.name, points);
      const fileName = safeFileName(region.id, route.name, i + 1);
      fs.writeFileSync(path.join(OUT_DIR, fileName), gpxContent);
      const distKm = estimateDistKm(route.coords);
      console.log(
        `  [${i + 1}/${selected.length}] ${fileName} (${route.coords.length} pts, ~${distKm.toFixed(1)} km)`
      );
    }
  }

  console.log("\nDone!");
}

function estimateDistKm(
  coords: Array<{ lat: number; lon: number }>
): number {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    const R = 6371;
    const toRad = (x: number) => (x * Math.PI) / 180;
    const dLat = toRad(coords[i].lat - coords[i - 1].lat);
    const dLon = toRad(coords[i].lon - coords[i - 1].lon);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(coords[i - 1].lat)) *
        Math.cos(toRad(coords[i].lat)) *
        Math.sin(dLon / 2) ** 2;
    d += 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return d;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
