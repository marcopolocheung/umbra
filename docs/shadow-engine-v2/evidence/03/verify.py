"""Offline integrity and factual checks for this research artifact."""
import hashlib, json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent
DOC = ROOT.parent.parent / '03-data-sources.md'
checks, failures = [], []

def check(name, condition):
    checks.append({'name': name, 'pass': bool(condition)})
    if not condition:
        failures.append(name)

sources = []
for path in sorted((ROOT / 'sources').glob('*.json')):
    meta = json.loads(path.read_text())
    sources.append(meta)
    # Captured bodies were removed on 2026-10-09; each record keeps its URL, byte count and
    # SHA-256, and the bodies stay in git history (8e5f463) for anyone re-verifying them.

for path in sorted((ROOT / 'http').glob('*.json')):
    meta = json.loads(path.read_text())
    body = path.with_suffix('.bin').read_bytes()
    check('range body ' + path.stem, len(body) == meta['bytes'] and
          hashlib.sha256(body).hexdigest() == meta['sha256'])

for path in [DOC, ROOT / 'README.md']:
    for target in re.findall(r'\]\(([^)]+)\)', path.read_text()):
        if not target.startswith(('https://', 'http://', '#')):
            check('local link ' + str(path.relative_to(ROOT.parent.parent)) + ':' + target,
                  (path.parent / target.split('#')[0]).exists())

doc = DOC.read_text()
for prefix, count in [('T', 10), ('B', 6), ('C', 3), ('V', 8)]:
    for i in range(1, count + 1):
        check('catalogue row ' + prefix + str(i), bool(re.search(r'\| \*\*' + prefix + str(i) + r'\b', doc)))

levels = json.loads((ROOT / 'terrain-levels.json').read_text())
check('51 site/level entries', len(levels) == 51)
for city in ['madrid', 'kent', 'singapore']:
    rows = [r for r in levels if r['name'] == city]
    check(city + ' level responses', len(rows) == 17 and all(r['status'] == (200 if r['z'] < 16 else 404) for r in rows))
for city, source in [('madrid', 'eudem/'), ('kent', 'ned13/')]:
    check(city + ' z14/15 contributor', all(source in r['headers'].get('x-amz-meta-x-imagery-sources', '') for r in levels if r['name'] == city and r['z'] in [14, 15]))

rasters = json.loads((ROOT / 'raster-metadata.json').read_text())['rows']
check('11 successful metadata probes', len(rasters) == 11 and all('error' not in r for r in rasters))
for row in rasters:
    if row['name'].startswith('chm-'):
        heights = [d for d in row['ifds'] if d['newSubfileType'] in [0, 1]]
        masks = [d for d in row['ifds'] if d['newSubfileType'] in [4, 5]]
        check(row['name'] + ' levels and masks', [d['width'] for d in heights] == [32768, 16384, 8192, 4096, 2048, 1024, 512] and len(masks) == 7)
lookup = {r['name']: r for r in rasters}
check('AWS GeoTIFF one IFD', len(lookup['aws-geotiff-madrid']['ifds']) == 1)
check('Copernicus GLO30 levels', [d['width'] for d in lookup['cop30']['ifds']] == [3600, 1800, 900, 450])
check('Copernicus GLO90 levels', [d['width'] for d in lookup['cop90']['ifds']] == [1200, 600, 300])
check('IGN grid spacing', abs(lookup['ign-egm08-rednap']['ifds'][0]['modelPixelScale'][0] - 1 / 60) < 1e-8)
check('LINZ 8 levels', len(lookup['linz-dem-AS21']['ifds']) == 8)

calc = json.loads((ROOT / 'calculations.json').read_text())['region']
check('506 tile volume arithmetic', calc['tiles'] == 506 and calc['cells'] == 506 * 256**2 and calc['six32BitBandsBytes'] == 506 * 256**2 * 24)
check('price scenario arithmetic', abs(calc['r2StorageUSDPerMonthScenario'] - calc['gzipWithRecipesBytesScenario'] / 1e9 * .015) < 1e-12)
check('author CHMv2 licence', json.loads((ROOT / 'sources/chm-zenodo-api.txt').read_text())['metadata']['license']['id'] == 'cc-by-4.0')
check('pinned Microsoft licence', 'CDLA Permissive 2.0' in (ROOT / 'sources/microsoft-pinned-readme.txt').read_text())

datum = json.loads((ROOT / 'datum-operations.json').read_text())
for row, accuracy in zip(datum['rows'], [2.1, 2.15, 1.113]):
    check(row['name'] + ' operation discovery', not row['available'] and
          row['unavailable'][0]['accuracy'] == accuracy)

(ROOT / 'source-manifest.json').write_text(json.dumps(sources, indent=2) + '\n')
result = {'offline': True, 'sourceRecords': len(sources), 'checks': checks, 'failures': failures}
(ROOT / 'checks.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'sourceRecords': len(sources), 'checks': len(checks), 'failures': failures}, indent=2))
raise SystemExit(bool(failures))
