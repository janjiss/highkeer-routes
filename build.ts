/**
 * Route tile builder
 * ------------------
 * Converts source GPX/GeoJSON files into a quadtree-friendly static structure
 * designed for GitHub Pages (or any static CDN) hosting.
 *
 * Output layout:
 *   routes/          Full-resolution route GeoJSON keyed by route_id
 *   idx/             Morton-code index tiles per zoom level
 *   meta.json        Master catalog (bbox, counts, zoom range)
 *
 * Index tile format (z8–z12):
 *   { "items": [ { "id", "name", "bbox": [w,s,e,n], "lenM", "eleM" } ] }
 *
 * Route format:
 *   GeoJSON Feature<LineString> with properties: name, distanceMeters, elevationGainM
 */

import * as fs from 'fs';
import * as path from 'path';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const SRC_DIR = process.env.SRC_DIR || './source';
const OUT_DIR = process.env.OUT_DIR || './out';

/** Zoom levels where we build index tiles. */
const INDEX_ZOOMS = [6, 8, 10, 12];

/** Maximum points per route before decimation (optional). */
const MAX_POINTS = 2000;

/** At low zooms we skip short routes to keep tiles tiny. */
const MIN_LENGTH_M_BY_ZOOM: Record<number, number> = {
  6: 5000,
  8: 2000,
  10: 500,
  12: 0,
};

/* ------------------------------------------------------------------ */
/* Simple GPX parser (no deps)                                         */
/* ------------------------------------------------------------------ */

function parseGpx(xml: string, fileName: string): Route | null {
  const getText = (el: Element, tag: string): string => {
    const c = el.getElementsByTagName(tag)[0];
    return c?.textContent?.trim() ?? '';
  };

  const doc = new (require('xmldom').DOMParser)().parseFromString(xml, 'text/xml');
  if (!doc) return null;

  const trk = doc.getElementsByTagName('trk')[0];
  if (!trk) return null;

  const name = getText(trk, 'name') || fileName.replace(/\.gpx$/i, '');
  const trkseg = trk.getElementsByTagName('trkseg')[0];
  if (!trkseg) return null;

  const points: { lat: number; lon: number; ele?: number }[] = [];
  const pts = trkseg.getElementsByTagName('trkpt');
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const lat = parseFloat(p.getAttribute('lat') ?? '');
    const lon = parseFloat(p.getAttribute('lon') ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const eleStr = p.getElementsByTagName('ele')[0]?.textContent?.trim() ?? '';
    const ele = parseFloat(eleStr);
    points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : undefined });
  }

  if (points.length < 2) return null;

  const coordinates: [number, number][] = points.map((p) => [p.lon, p.lat]);
  const elevationsM = points.map((p) => (p.ele !== undefined ? p.ele : null));
  const distanceMeters = polylineLengthMeters(coordinates);
  const elevationGainM = elevationGainFromAltitudes(elevationsM);

  let bbox = bboxFromCoords(coordinates);

  return {
    id: `${safeId(name)}_${mortonHash(bbox)}`,
    name,
    coordinates,
    elevationsM,
    distanceMeters,
    elevationGainM,
    bbox,
  };
}

/* ------------------------------------------------------------------ */
/* Geo helpers                                                         */
/* ------------------------------------------------------------------ */

interface Route {
  id: string;
  name: string;
  coordinates: [number, number][];
  elevationsM: (number | null)[];
  distanceMeters: number;
  elevationGainM: number | null;
  bbox: BBox;
}

type BBox = [west: number, south: number, east: number, north: number];

function bboxFromCoords(coords: [number, number][]): BBox {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

function polylineLengthMeters(coords: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    len += haversineMeters(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  return len;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function elevationGainFromAltitudes(elevationsM: (number | null)[]): number | null {
  let gain = 0;
  let hasAny = false;
  for (let i = 1; i < elevationsM.length; i++) {
    const prev = elevationsM[i - 1];
    const cur = elevationsM[i];
    if (prev != null && cur != null) {
      hasAny = true;
      if (cur > prev) gain += cur - prev;
    }
  }
  return hasAny ? Math.round(gain) : null;
}

function safeId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/* ------------------------------------------------------------------ */
/* Tile / Morton helpers                                               */
/* ------------------------------------------------------------------ */

function lon2tile(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

function lat2tile(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, zoom)
  );
}

function tile2lon(x: number, zoom: number): number {
  return (x / Math.pow(2, zoom)) * 360 - 180;
}

function tile2lat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function mortonCode(x: number, y: number): number {
  let mc = 0;
  for (let i = 0; i < 16; i++) {
    mc |= ((x >> i) & 1) << (2 * i + 1);
    mc |= ((y >> i) & 1) << (2 * i);
  }
  return mc;
}

function mortonHash(bbox: BBox): string {
  // simple hash for id uniqueness
  const sum = bbox[0] + bbox[1] + bbox[2] + bbox[3];
  return Math.abs(Math.floor(sum * 10000)).toString(36).slice(0, 6);
}

/** Which tiles does a bbox touch at a given zoom? */
function tilesForBBox(bbox: BBox, zoom: number): Array<{ x: number; y: number; mc: number }> {
  const minX = lon2tile(bbox[0], zoom);
  const maxX = lon2tile(bbox[2], zoom);
  const minY = lat2tile(bbox[3], zoom); // north
  const maxY = lat2tile(bbox[1], zoom); // south
  const tiles: Array<{ x: number; y: number; mc: number }> = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      tiles.push({ x, y, mc: mortonCode(x, y) });
    }
  }
  return tiles;
}

/* ------------------------------------------------------------------ */
/* Decimation (Ramer–Douglas–Peucker style optional)                   */
/* ------------------------------------------------------------------ */

function decimate(coords: [number, number][], maxPoints: number): [number, number][] {
  if (coords.length <= maxPoints) return coords;
  const step = Math.ceil(coords.length / maxPoints);
  const out: [number, number][] = [];
  for (let i = 0; i < coords.length; i += step) {
    out.push(coords[i]);
  }
  if (out[out.length - 1] !== coords[coords.length - 1]) {
    out.push(coords[coords.length - 1]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

async function build() {
  const src = path.resolve(SRC_DIR);
  const out = path.resolve(OUT_DIR);

  if (!fs.existsSync(src)) {
    console.error(`Source directory not found: ${src}`);
    process.exit(1);
  }

  fs.mkdirSync(path.join(out, 'routes'), { recursive: true });
  fs.mkdirSync(path.join(out, 'idx'), { recursive: true });

  const files = fs
    .readdirSync(src)
    .filter((f) => f.toLowerCase().endsWith('.gpx'));

  if (files.length === 0) {
    console.warn(`No GPX files found in ${src}`);
  }

  const routes: Route[] = [];

  for (const file of files) {
    const xml = fs.readFileSync(path.join(src, file), 'utf-8');
    const route = parseGpx(xml, file);
    if (route) {
      routes.push(route);
    } else {
      console.warn(`Could not parse ${file}`);
    }
  }

  // Write full routes
  for (const route of routes) {
    const geojson = {
      type: 'Feature',
      properties: {
        id: route.id,
        name: route.name,
        distanceMeters: route.distanceMeters,
        elevationGainM: route.elevationGainM,
      },
      geometry: {
        type: 'LineString',
        coordinates: decimate(route.coordinates, MAX_POINTS),
      },
    };
    fs.writeFileSync(
      path.join(out, 'routes', `${route.id}.geojson`),
      JSON.stringify(geojson, null, 2)
    );
  }

  // Build index tiles per zoom
  const globalBbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];

  for (const zoom of INDEX_ZOOMS) {
    const tileMap = new Map<number, Array<{ id: string; name: string; bbox: BBox; lenM: number; eleM: number | null; start: [number, number] }>>();

    for (const route of routes) {
      if (route.distanceMeters < (MIN_LENGTH_M_BY_ZOOM[zoom] ?? 0)) continue;

      // Update global bbox
      globalBbox[0] = Math.min(globalBbox[0], route.bbox[0]);
      globalBbox[1] = Math.min(globalBbox[1], route.bbox[1]);
      globalBbox[2] = Math.max(globalBbox[2], route.bbox[2]);
      globalBbox[3] = Math.max(globalBbox[3], route.bbox[3]);

      const tiles = tilesForBBox(route.bbox, zoom);
      const item = {
        id: route.id,
        name: route.name,
        bbox: route.bbox,
        lenM: Math.round(route.distanceMeters),
        eleM: route.elevationGainM,
        start: route.coordinates[0] as [number, number],
      };
      for (const t of tiles) {
        const list = tileMap.get(t.mc) || [];
        list.push(item);
        tileMap.set(t.mc, list);
      }
    }

    const zoomDir = path.join(out, 'idx', `z${zoom}`);
    fs.mkdirSync(zoomDir, { recursive: true });

    for (const [mc, items] of tileMap) {
      const deduped = items.filter(
        (v, i, a) => a.findIndex((t) => t.id === v.id) === i
      );
      fs.writeFileSync(
        path.join(zoomDir, `${String(mc).padStart(6, '0')}.json`),
        JSON.stringify({ items: deduped })
      );
    }

    console.log(`Zoom ${zoom}: ${tileMap.size} tiles, ${routes.length} routes considered`);
  }

  // Master meta
  const meta = {
    version: 1,
    routeCount: routes.length,
    zoomRange: [Math.min(...INDEX_ZOOMS), Math.max(...INDEX_ZOOMS)],
    indexZooms: INDEX_ZOOMS,
    bbox: globalBbox.every(Number.isFinite) ? globalBbox : [-180, -85, 180, 85],
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));

  console.log(`\nDone. Output: ${out}`);
  console.log(`  Routes: ${routes.length}`);
  console.log(`  Index zooms: ${INDEX_ZOOMS.join(', ')}`);
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
