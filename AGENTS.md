# Route Builder Notes

## Source Of Truth

- `main` in `janjiss/highkeer-routes` is the source of truth for route data.
- Keep GPX source files in `source/`.
- Do not hand-edit generated files in `out/` or treat `gh-pages` as the durable source.
- `gh-pages` is the published static API output consumed by the app.

## Publish Flow

- Changes to `main` run `.github/workflows/publish-routes.yml`.
- The workflow runs `npm ci`, `npm run build`, then publishes `out/` to `gh-pages`.
- To verify the live API, check `https://janjiss.github.io/highkeer-routes/meta.json`.
- A healthy publish after the Kurzeme cleanup reports `routeCount: 97` and a fresh `generatedAt`.

## Route Quality Checks

- Watch for long straight lines caused by coordinate jumps.
- For short hiking/nature routes, point-to-point jumps over `150-200m` are suspicious.
- The Kurzeme cleanup removed routes using this stricter outlier rule:
  - segment length `> 300m`
  - and more than `3x` the route's 90th percentile segment length.
- If a jump is not safely repairable from source data, remove the source GPX rather than publishing misleading geometry.

## Kurzeme Cleanup

- The jagged Kurzeme routes were generated GPX tracks with extreme intra-route segment outliers.
- The cleanup removed the bad source GPX files from `source/`, rebuilt `out/`, and verified no remaining Latvia/Kurzeme output matched the same jump pattern.
- Removed route files should return `404` from the public API and should not appear in changed index tiles.

## Useful Commands

```bash
npm ci
npm run build
```

Verify source jumps:

```bash
python3 - <<'PY'
import os, re, math
root = 'source'
def dist(a, b):
    lon1, lat1 = a; lon2, lat2 = b; R = 6371000
    p1 = math.radians(lat1); p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1); dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.atan2(math.sqrt(h), math.sqrt(1 - h))
bad = []
for fn in sorted(os.listdir(root)):
    if fn.startswith('kurzeme_') and fn.endswith('.gpx'):
        txt = open(os.path.join(root, fn), encoding='utf-8').read()
        pts = [(float(m.group(2)), float(m.group(1))) for m in re.finditer(r'<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"', txt)]
        if len(pts) > 10:
            segs = [dist(pts[i - 1], pts[i]) for i in range(1, len(pts))]
            p90 = sorted(segs)[int(len(segs) * .9)]
            mx = max(segs)
            if mx > 300 and mx > p90 * 3:
                bad.append((fn, mx, p90))
print('remaining_bad', len(bad))
for row in bad:
    print(row)
PY
```
