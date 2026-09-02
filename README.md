# AIXM to GeoJSON Converter

Converts [AIXM](https://www.aixm.aero/) airspace data to GeoJSON. Two generations of the
model are read; the generation is detected from the root element, not from a version
attribute:

| data set                                 | AIXM  | encoding                                                 |
| ---------------------------------------- | ----- | -------------------------------------------------------- |
| `ED_Airspace_StrokedBorders_*.xml` (DFS) | 5.1   | national borders resolved into explicit coordinates      |
| `ED_Airspace_ReferencedBorders_*.xml`    | 5.1   | national borders referenced as `aixm:GeoBorder` features |
| `AIXM4.5_all_FR_OM_*.xml` (SIA, France)  | 4.5   | `AIXM-Snapshot` with `Ase` / `Abd` / `Avx` entities      |

Only airspace definitions are read. Other feature types - aerodromes, navaids, obstacles,
routes - are ignored.

## AIXM 4.5

AIXM 4.5 is a different model, not an older spelling of 5.1. There is no GML: an airspace
`Ase` is linked to a border `Abd`, which carries a flat, ordered list of vertices `Avx`.
The `codeType` of a vertex describes **the segment from that vertex to the next one**:

| `codeType` | meaning                                             |
| ---------- | --------------------------------------------------- |
| `GRC`      | great circle to the next vertex                     |
| `RHL`      | rhumb line to the next vertex                       |
| `CWA`      | clockwise arc around `geoLatArc`/`geoLongArc`       |
| `CCA`      | counter-clockwise arc                               |
| `FNT`      | follow the referenced national border (`Gbr`)       |

Coordinates are `DDMMSS.ss` with a hemisphere letter and datum WGE throughout, so there is
no CRS attribute and no axis-order question. Two further entities matter: `Adg` states that
an airspace has the same extent as another one, and `Gbr`/`Gbv` hold the national borders
that `FNT` vertices refer to.

### What the SIA data set yields

Converting `AIXM4.5_all_FR_OM_2026-09-03.xml` (41.8 MB, AIRAC 09/26):

```
airspaces in file                       5061
converted                               2217
skipped: point without extent           2135
skipped: no geometry in file             698
extent taken from another airspace        85
```

The large "point without extent" group is not a defect of the converter. The SIA publishes
thousands of activity zones - model flying (`txtLocalType` `AER`), glider winch launching
(`TRPLA`), parachuting (`PJE`) - as a **single position with no radius anywhere in the
data**. Turning them into circles would mean inventing an extent the AIP does not state, so
they are counted and skipped. The "no geometry" group is mostly dangling `Adg` references:
501 of the 597 point at an airspace that is not in the file.

### Frequencies

AIXM 4.5 links a frequency to an airspace through the service, not directly:

```
Ase  <--  Sae  -->  Ser  <--  Fqy
```

`Sae` is the service/airspace association, `Fqy` carries the frequency for the same
service. Joining on `SerUid/@mid` and joining on the composite key
(`UniUid/txtName` + `codeType` + `noSeq`) resolve the same 823 of 823 associations in the
09/26 cycle, so the shorter `@mid` is used.

Of the 2217 converted airspaces, 677 carry at least one frequency - CTR 104 of 133, TMA
355 of 510, CTA 58 of 99. The activity zones legitimately have none.

**No single "primary" frequency is emitted.** 558 of those 677 carry several, and picking
one for a format that only holds one value - OpenAIR `AF`, for instance - is an editorial
decision (TWR for a CTR, APP for a TMA) that belongs to the consumer. The service type
travels with each entry so that choice can be made downstream:

```json
"frequencies": [
    { "type": "TWR", "value": 118.105, "unit": "MHZ", "name": "BLAGNAC - TOWER", "hours": "H24" },
    { "type": "APP", "value": 121.105, "unit": "MHZ", "name": "BLAGNAC - APPROACH", "hours": "H24" }
]
```

The call sign is published once per language - French always, English for 1494 of the 1743
frequencies. English is preferred, French kept where there is no English.

### Differences in the output

- **`id`**: AIXM 4.5 has no UUID, and `AseUid/@mid` is a database row id that changes
  between cycles. The id is therefore a deterministic UUIDv5 over `codeType|codeId`, which
  the AIP keeps stable - so incremental updates work the same way as for 5.1.
- **`designator`** and **`remarks`** are added. For the SIA `D-OTHER` zones `txtRmk` is the
  only place stating what the zone actually is.
- A ring that returns to an earlier vertex - two lobes touching at a point, as in `TF25` or
  the Strasbourg sectors - is split and emitted as a `MultiPolygon` instead of being
  rejected.

## Installation

```bash
npm install
```

Requires Node 20 or later.

## Usage

As a library:

```js
import { convertFile, validateGeojson } from '@openaip/aixm-to-geojson';

const { geojson, stats, aixmVersion } = convertFile('./AIXM4.5_all_FR_OM_2026-09-03.xml');
console.log(`AIXM ${aixmVersion}: ${stats.converted} airspaces, ${stats.failed} failures`);
console.log(validateGeojson(geojson).valid);
```

`convert(parsedXml, config)` dispatches on the detected generation, `detectAixmVersion`
returns `'5.1'` or `'4.5'`, and `convertAirspaces` / `convertAixm45` can be called directly
if the generation is already known.

`convertAirspaces(parsedXml, config)` takes an already parsed document if you want to convert
several times without re-parsing. Configuration:

| option                | default | meaning                                                          |
| --------------------- | ------- | ---------------------------------------------------------------- |
| `geometryDetail`      | `180`   | points used for a full 360° circle                               |
| `joinToleranceMeters` | `5`     | coordinates closer than this to their predecessor are dropped    |
| `fixGeometries`       | `true`  | repair self-intersecting rings instead of rejecting the airspace |

On the command line:

```bash
node cli.js -f <aixm.xml> [-f <another.xml>] [-o <outdir>] [--geometry-detail 180] [--no-fix]
```

The CLI writes one `.geojson` per input and prints a conversion report: member counts, ring
part types, GeoBorder usage, geometry quality and any unmapped AIXM values.

## Output

A GeoJSON `FeatureCollection` validated against [`schemas/geojson-schema.json`](schemas/geojson-schema.json):

```json
{
    "type": "Feature",
    "id": "48ceb197-a37a-46c6-941f-0733a1cf9141",
    "properties": {
        "name": "HARTENHOLM",
        "type": "OTHER",
        "class": "UNCLASSIFIED",
        "activity": "NONE",
        "upperCeiling": { "value": 1500, "unit": "FT", "referenceDatum": "GND" },
        "lowerCeiling": { "value": 0, "unit": "FT", "referenceDatum": "GND" },
        "activatedByNotam": false
    },
    "geometry": { "type": "Polygon", "coordinates": [[[10.04, 53.92], "..."]] }
}
```

The feature `id` is the airspace's `gml:identifier` — a UUID that is stable across AIRAC
cycles and therefore the key an incremental import can diff on.

## Notes on the AIXM/GML encoding

The rules below are not optional details; getting any of them wrong produces plausible-looking
but wrong geometry rather than an error. Sources are the
[AIXM Coding Guidelines](https://ext.eurocontrol.int/aixm_confluence/display/ACG/Arc+by+Centre+Point)
and ISO 19136.

**Coordinate order.** `srsName="urn:ogc:def:crs:EPSG::4326"` is latitude-first — the opposite
of GeoJSON. The CRS is resolved explicitly rather than assumed (`isLatLonOrder`).

**Arc direction is signed.** With a latitude-first CRS an arc runs clockwise when
`startAngle < endAngle` and counter-clockwise when `startAngle > endAngle`. Roughly 40 % of the
arcs in the DFS data are counter-clockwise. Normalising the sweep to a positive value draws
those the wrong way round while still ending at the correct point, so endpoint checks do not
catch the error.

**Arcs are over-specified.** The guidelines note that the distance from the centre to the
start/end points "is not quite the same due to round-off error and is also usually different
from the radius". Taking radius and angles at face value misses the adjacent ring vertex by
some 145 m on average. Each arc is therefore re-based on its neighbouring vertices, with the
radius interpolated between the two measured values, which closes the joins exactly.

**Geodesics, not a sphere.** Distances and bearings run through GeographicLib on the WGS84
ellipsoid. A spherical model (as used by turf's `destination`/`circle`) deviates by up to
0.47 % of the radius against this data — about 300 m on a 34 NM arc.

**GeoBorders are longer than the portion used.** A `gml:curveMember` carrying
`xlink:href="urn:uuid:…"` references an entire national border. Which portion applies follows
from ISO 19136's requirement that a ring's curves be "contiguous and connected in a cycle",
i.e. from the adjacent curve members. Three details matter: the anchor must be projected onto
the border _line_ rather than snapped to the nearest _vertex_ (at the DE/PL maritime border the
difference is 28 km); consecutive references to the _same_ border form one continuous stretch;
consecutive references to _different_ borders form a chain across a tripoint, where the borders
in between are traversed completely.

**Aggregating airspaces.** An airspace may carry no geometry of its own but a sequence of
`aixm:geometryComponent`s referencing other airspaces, ordered by `aixm:operationSequence`
(`BASE`, then `UNION` / `SUBTR` / `INTERS`). These are resolved recursively and applied in
order. Where their vertical limits are `xsi:nil`, the envelope of the contributors is used.

**Cross-border airspaces.** A few airspaces reference their foreign half through an abstract
`urn:aixm:Airspace(…)` key that is not resolvable from a single national data set. They are
emitted from the resolvable part and reported as partial rather than dropped.

## Verification

The two DFS encodings describe the same airspaces, which makes them a check on each other.
Converting both AIRAC 2026-08-06 snapshots and matching the 1673 features pairwise by UUID:

| intersection over union | airspaces |
| ----------------------- | --------- |
| ≥ 0.9999                | 1670      |
| ≥ 0.999                 | 3         |
| < 0.999                 | 0         |

Both files convert completely (1673 / 1673, no failures) and the output validates against the
schema. The bundled fixture (`tests/fixtures/aixm-airspace.xml`, AIRAC 2023-07-13) converts
completely as well and is covered by `tests/fixture.test.js`.

```bash
npm test
```

## Known gaps

-   **Airspace types.** `aixm:type` / `aixm:localType` are mapped in `src/mappings.js` against
    the enum of this package's schema, which is narrower than openAIP's own type list. Military
    low flying areas (`ETLFA*`) and Free Route Airspace gates (`GT`) currently fall back to
    `OTHER`, and the `LASER` activity has no counterpart.
-   **Timesheets.** The `aixm:Timesheet` blocks carrying activation schedules are not read;
    `activatedByNotam` is always `false`.
-   **Interior rings.** Surfaces with `gml:interior` (holes) are rejected. Neither DFS data set
    contains any.
