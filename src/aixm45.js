import { createHash } from 'node:crypto';
import { area, featureCollection, kinks, unkinkPolygon } from '@turf/turf';
import { child, children, text } from './xml.js';
import { clipBorder } from './geometry.js';
import { destination, distanceMeters, inverse } from './geodesic.js';
import { mapAirspaceMetadata45 } from './mappings.js';
import { createVerticalLimit45, dmsToDecimal, radiusToMeters45 } from './units.js';

/*
 AIXM 4.5 ("AIXM-Snapshot") is a different model from AIXM 5.1, not an older spelling
 of it. There is no GML: geometry is carried by a flat, ordered list of vertices.

   Ase   airspace          key = AseUid/@mid, plus codeType + codeId
   Abd   airspace border   AbdUid/AseUid points back at the airspace, then a run of Avx
   Avx   vertex            the codeType describes the segment from THIS vertex to the
                           NEXT one, not the vertex itself
   Adg   derived geometry  "this airspace has the same extent as that one"
   Gbr   geo border        a named national border, vertices in Gbv

 Avx codeType values in the SIA data set:
   GRC   great circle to the next vertex          19773
   RHL   rhumb line to the next vertex              888
   CWA   clockwise arc to the next vertex           399
   CCA   counter-clockwise arc to the next vertex   197
   FNT   follow the referenced Gbr to the next      458

 Coordinates are DDMMSS.ss / DDDMMSS.ss with a hemisphere letter, datum WGE (WGS-84)
 throughout - there is no CRS attribute and no axis-order question.

 Frequencies hang off a second chain that meets the airspace only through the service:

   Ase  <--  Sae  -->  Ser  <--  Fqy

 `Sae` is the service/airspace association, `Fqy` carries the frequency for the same
 service. Joining on `SerUid/@mid` and joining on the composite key
 (UniUid/txtName + codeType + noSeq) resolve the same 823 of 823 associations, so the
 shorter `@mid` is used.
*/

const DEFAULT_CONFIG = {
    geometryDetail: 180,
    joinToleranceMeters: 5,
    fixGeometries: true,
};

/**
 * Converts an AIXM 4.5 snapshot into a GeoJSON FeatureCollection.
 *
 * @param {Object[]} parsedXml
 * @param {Object} [userConfig]
 * @return {{geojson: Object, stats: Object}}
 */
export function convertAixm45(parsedXml, userConfig) {
    const config = { ...DEFAULT_CONFIG, ...userConfig };
    const stats = createStats();

    const snapshot = parsedXml.find((node) => node.name === 'AIXM-Snapshot');
    if (snapshot == null) throw new Error("Not an AIXM 4.5 snapshot: missing 'AIXM-Snapshot'");
    stats.effective = snapshot.attrs?.effective ?? null;
    stats.origin = snapshot.attrs?.origin ?? null;

    const airspaces = new Map(); // AseUid/@mid -> Ase node
    const borderNodes = new Map(); // AseUid/@mid -> Abd node
    const sameExtent = new Map(); // AseUid/@mid -> AseUid/@mid of the airspace to copy
    const geoBorders = new Map(); // GbrUid/@mid -> { name, coordinates }
    const servicesOfAirspace = new Map(); // AseUid/@mid -> [SerUid/@mid]
    const frequenciesOfService = new Map(); // SerUid/@mid -> [frequency]

    for (const node of snapshot.children) {
        stats.members[node.name] = (stats.members[node.name] ?? 0) + 1;
        switch (node.name) {
            case 'Ase': {
                const mid = child(node, 'AseUid')?.attrs?.mid;
                if (mid != null) airspaces.set(mid, node);
                break;
            }
            case 'Abd': {
                const mid = child(child(node, 'AbdUid'), 'AseUid')?.attrs?.mid;
                if (mid != null) borderNodes.set(mid, node);
                break;
            }
            case 'Adg': {
                const own = child(child(node, 'AdgUid'), 'AseUid')?.attrs?.mid;
                const other = child(node, 'AseUidSameExtent')?.attrs?.mid;
                if (own != null && other != null) sameExtent.set(own, other);
                break;
            }
            case 'Sae': {
                const uid = child(node, 'SaeUid');
                const airspace = child(uid, 'AseUid')?.attrs?.mid;
                const service = child(uid, 'SerUid')?.attrs?.mid;
                if (airspace == null || service == null) break;
                if (servicesOfAirspace.has(airspace) === false) servicesOfAirspace.set(airspace, []);
                servicesOfAirspace.get(airspace).push(service);
                break;
            }
            case 'Fqy': {
                const uid = child(node, 'FqyUid');
                const serviceUid = child(uid, 'SerUid');
                const service = serviceUid?.attrs?.mid;
                if (service == null) break;
                const frequency = readFrequency(node, uid, serviceUid);
                if (frequency == null) break;
                if (frequenciesOfService.has(service) === false) frequenciesOfService.set(service, []);
                frequenciesOfService.get(service).push(frequency);
                break;
            }
            case 'Gbr': {
                const mid = child(node, 'GbrUid')?.attrs?.mid;
                if (mid == null) break;
                geoBorders.set(mid, {
                    name: text(child(node, 'GbrUid'), 'txtName'),
                    // not `.map(vertexPosition)`: map passes the index as the second
                    // argument, which would be read as the field-name suffix
                    coordinates: children(node, 'Gbv').map((vertex) => vertexPosition(vertex)),
                });
                break;
            }
            default:
                break; // navaids, aerodromes, routes, obstacles - not airspace
        }
    }

    stats.borders.available = geoBorders.size;

    const context = {
        airspaces,
        borderNodes,
        sameExtent,
        geoBorders,
        servicesOfAirspace,
        frequenciesOfService,
        config,
        stats,
        cache: new Map(),
    };
    const features = [];
    for (const mid of airspaces.keys()) {
        try {
            const feature = createFeature(mid, context);
            if (feature != null) features.push(feature);
        } catch (e) {
            stats.failed++;
            stats.failures[e.message] = (stats.failures[e.message] ?? 0) + 1;
            if (stats.failureSamples.length < 15)
                stats.failureSamples.push(`${identOf(airspaces.get(mid))}: ${e.message}`);
        }
    }

    return { geojson: featureCollection(features), stats };
}

/**
 * @return {Object}
 */
function createStats() {
    return {
        effective: null,
        origin: null,
        members: {},
        converted: 0,
        failed: 0,
        failures: {},
        failureSamples: [],
        parts: {},
        sameExtent: 0,
        pointOnly: 0,
        withoutGeometry: 0,
        pinched: 0,
        multiPolygons: 0,
        withFrequency: 0,
        withSeveralFrequencies: 0,
        selfIntersecting: 0,
        repaired: 0,
        unmapped: {},
        borders: { available: 0, used: {}, ringsUsingBorders: 0 },
    };
}

/*
 AIXM 4.5 has no UUID. `AseUid/@mid` looks like a key but is a database row id that the
 SIA renumbers between cycles, so it is useless for incremental updates - the very thing
 the 5.1 path relies on. A deterministic UUID is derived from the natural key instead
 (codeType + codeId), which the AIP keeps stable: `LFSB / TMA` is the same airspace next
 cycle. Same construction as RFC 4122 name-based UUIDs (SHA-1, version 5).
*/
const UUID_NAMESPACE = '9f1a4a1e-0b8a-5a3e-9c2b-6f1c0a7d4e21';

/**
 * @param {string} name
 * @return {string}
 */
export function stableUuid(name) {
    const namespaceBytes = Buffer.from(UUID_NAMESPACE.replace(/-/g, ''), 'hex');
    const hash = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest();
    hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
    hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = hash.subarray(0, 16).toString('hex');

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Reads one `Fqy` element.
 *
 * The call sign is published once per language - French always, English for 1494 of the
 * 1743 frequencies. English is preferred because the output is consumed
 * internationally; where it is missing the French one is kept rather than dropping the
 * call sign.
 *
 * @param {Object} node - Fqy
 * @param {Object} uid - FqyUid
 * @param {Object} serviceUid - FqyUid/SerUid
 * @return {Object|null}
 */
function readFrequency(node, uid, serviceUid) {
    const value = Number.parseFloat(text(uid, 'valFreqTrans'));
    if (Number.isFinite(value) === false) return null;

    const callSigns = new Map();
    for (const cdl of children(node, 'Cdl')) {
        const sign = text(cdl, 'txtCallSign');
        if (sign != null) callSigns.set(text(cdl, 'codeLang') ?? 'FR', sign);
    }

    return {
        type: text(serviceUid, 'codeType'),
        value,
        unit: text(node, 'uomFreq') ?? 'MHZ',
        name: callSigns.get('EN') ?? callSigns.values().next().value ?? null,
        hours: text(child(node, 'Ftt'), 'codeWorkHr'),
    };
}

/**
 * All frequencies of an airspace, in the order the services are associated.
 *
 * Deliberately no single "primary" frequency: 585 of the 708 airspaces that have one
 * carry SEVERAL, and picking one for a format that only holds a single value (OpenAIR
 * `AF`) is an editorial decision - TWR for a CTR, APP for a TMA - that belongs to the
 * consumer, not to a converter. The service type is carried along so that choice can be
 * made downstream.
 *
 * @return {Object[]}
 */
function frequenciesOf(mid, context) {
    const services = context.servicesOfAirspace.get(mid) ?? [];
    const frequencies = [];
    for (const service of services) {
        for (const frequency of context.frequenciesOfService.get(service) ?? []) frequencies.push(frequency);
    }

    return frequencies;
}

/**
 * @param {Object} node - Ase
 * @return {string}
 */
function identOf(node) {
    const uid = child(node, 'AseUid');

    return `${text(uid, 'codeType') ?? '-'} ${text(uid, 'codeId') ?? '-'}`.trim();
}

/**
 * `<geoLat>491216.00N</geoLat><geoLong>0021100.00E</geoLong>` -> [lon, lat]
 *
 * @param {Object} node - any node carrying geoLat/geoLong, optionally with the `Arc` suffix
 * @param {string} [suffix]
 * @return {number[]}
 */
function vertexPosition(node, suffix = '') {
    const lat = text(node, `geoLat${suffix}`);
    const lon = text(node, `geoLong${suffix}`);
    if (lat == null || lon == null) throw new Error('Vertex without coordinates');

    return [dmsToDecimal(lon), dmsToDecimal(lat)];
}

/**
 * @return {Object|null} feature, or null if the airspace carries no area
 */
function createFeature(mid, context) {
    const { airspaces, stats } = context;
    const node = airspaces.get(mid);
    const uid = child(node, 'AseUid');

    const metadata = mapAirspaceMetadata45({
        type: text(uid, 'codeType'),
        localType: text(node, 'txtLocalType'),
        airspaceClass: text(node, 'codeClass'),
        activity: text(node, 'codeActivity'),
    });
    for (const value of metadata.unmapped) stats.unmapped[value] = (stats.unmapped[value] ?? 0) + 1;

    const geometry = buildGeometry(mid, context, new Set());
    if (geometry == null) return null;

    const name = text(node, 'txtName') ?? text(uid, 'codeId');
    if (name == null) throw new Error('Missing airspace name');

    const frequencies = frequenciesOf(mid, context);
    if (frequencies.length > 0) {
        stats.withFrequency++;
        if (frequencies.length > 1) stats.withSeveralFrequencies++;
    }

    stats.converted++;

    return {
        type: 'Feature',
        id: stableUuid(`${text(uid, 'codeType')}|${text(uid, 'codeId')}`),
        properties: {
            name,
            designator: text(uid, 'codeId'),
            type: metadata.type,
            class: metadata.class,
            activity: metadata.activity,
            ...verticalLimits(node),
            ...(frequencies.length > 0 ? { frequencies } : {}),
            activatedByNotam: text(child(node, 'Att'), 'codeWorkHr') === 'NOTAM',
            remarks: text(node, 'txtRmk'),
        },
        geometry,
    };
}

/**
 * @param {Object} node - Ase
 * @return {{upperCeiling: Object, lowerCeiling: Object}}
 */
function verticalLimits(node) {
    return {
        upperCeiling: createVerticalLimit45(
            text(node, 'valDistVerUpper'),
            text(node, 'uomDistVerUpper'),
            text(node, 'codeDistVerUpper')
        ),
        lowerCeiling: createVerticalLimit45(
            text(node, 'valDistVerLower'),
            text(node, 'uomDistVerLower'),
            text(node, 'codeDistVerLower')
        ),
    };
}

/**
 * @return {Object|null} geometry, or null if this airspace has no area
 */
function buildGeometry(mid, context, visiting) {
    const { borderNodes, sameExtent, cache, stats } = context;
    if (cache.has(mid)) return cache.get(mid);
    if (visiting.has(mid)) throw new Error('Circular Adg same-extent reference');
    visiting.add(mid);

    let geometry = null;
    const border = borderNodes.get(mid);
    if (border != null) {
        geometry = polygonFromBorder(border, context);
    } else if (sameExtent.has(mid)) {
        // An Adg says "same extent as that airspace" - typically a vertically split
        // volume such as `LFBZ6.20` sharing the outline of `LFBZ6`.
        geometry = buildGeometry(sameExtent.get(mid), context, visiting);
        if (geometry != null) stats.sameExtent++;
    } else {
        stats.withoutGeometry++;
    }

    visiting.delete(mid);
    cache.set(mid, geometry);

    return geometry;
}

/**
 * @return {Object|null}
 */
function polygonFromBorder(border, context) {
    const { config, stats } = context;
    const vertices = children(border, 'Avx');

    /*
     2118 of the 4452 borders in the SIA data set consist of a SINGLE vertex. Those are
     not degenerate polygons but point features: model flying sites (txtLocalType AER),
     winch launch sites (TRPLA) and similar activity zones, published as a position with
     no radius anywhere in the data. Turning them into circles would mean inventing an
     extent the AIP does not state, so they are reported and skipped.

     Two vertices CAN enclose an area, though, as long as one of the segments is an arc:
     `CTR LFKB` is a 9 NM arc closed by its chord. Only a pair of straight segments is
     degenerate.
    */
    const hasArc = vertices.some((vertex) => ['CWA', 'CCA'].includes(text(vertex, 'codeType')));
    if (vertices.length < 3 && (vertices.length < 2 || hasArc === false)) {
        if (vertices.length > 0) stats.pointOnly++;
        else stats.withoutGeometry++;

        return null;
    }

    const { rings, usedBorders, segmentKinds } = ringFromVertices(vertices, context);
    for (const [kind, count] of Object.entries(segmentKinds)) stats.parts[kind] = (stats.parts[kind] ?? 0) + count;
    for (const name of usedBorders) stats.borders.used[name] = (stats.borders.used[name] ?? 0) + 1;
    if (usedBorders.length > 0) stats.borders.ringsUsingBorders++;
    if (rings.length > 1) stats.pinched++;

    const polygons = [];
    for (const ring of rings) {
        let polygon = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
        if (kinks(polygon).features.length > 0) {
            stats.selfIntersecting++;
            if (config.fixGeometries === false) throw new Error('Self-intersecting ring');
            polygon = largestPolygon(unkinkPolygon(polygon));
            stats.repaired++;
        }
        polygons.push(polygon.geometry.coordinates);
    }

    if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0] };
    stats.multiPolygons++;

    return { type: 'MultiPolygon', coordinates: polygons };
}

/**
 * Walks the vertex list and builds the closed ring.
 *
 * The list is cyclic: the codeType of the LAST vertex describes the segment back to the
 * first one, which is what closes the ring.
 *
 * @return {{coordinates: number[][], usedBorders: string[], segmentKinds: Object}}
 */
function ringFromVertices(vertices, context) {
    const { config } = context;
    const positions = vertices.map((vertex) => vertexPosition(vertex));
    const segmentKinds = {};
    const usedBorders = [];
    let coordinates = [];

    for (let index = 0; index < vertices.length; index++) {
        const vertex = vertices[index];
        const from = positions[index];
        const to = positions[(index + 1) % positions.length];
        const kind = text(vertex, 'codeType');
        segmentKinds[kind] = (segmentKinds[kind] ?? 0) + 1;

        coordinates.push(from);
        switch (kind) {
            // Great circle vs. rhumb line: over the length of an airspace boundary the
            // difference stays far below the precision of the published coordinates, so
            // both are drawn as a straight connection to the next vertex.
            case 'GRC':
            case 'RHL':
                break;
            case 'CWA':
            case 'CCA':
                coordinates.push(...arcCoordinates(vertex, from, to, kind === 'CWA', config));
                break;
            case 'FNT':
                coordinates.push(...borderCoordinates(vertex, from, to, context, usedBorders));
                break;
            default:
                throw new Error(`Unsupported vertex type '${kind}'`);
        }
    }

    coordinates = dropAdjacentDuplicates(coordinates, config.joinToleranceMeters);
    if (coordinates.length < 3) throw new Error(`Ring collapsed to ${coordinates.length} coordinates`);

    const rings = splitPinchedRing(coordinates).filter((ring) => ring.length >= 4);
    if (rings.length === 0) throw new Error('Ring collapsed while splitting');

    return { rings, usedBorders, segmentKinds };
}

/**
 * Builds an arc between two ring vertices.
 *
 * As in AIXM 5.1 the construct is over-specified: centre, radius and the two end points
 * rarely agree exactly. The ring vertices are authoritative - they are the published AIP
 * coordinates - so the arc is re-based onto them and the radius interpolated between the
 * two measured values. The direction comes from the vertex type (CWA/CCA) and not from
 * the sign of an angle difference, which is the one real simplification 4.5 offers over
 * 5.1's ArcByCenterPoint.
 *
 * @return {number[][]} intermediate points, excluding both end points
 */
function arcCoordinates(vertex, from, to, clockwise, config) {
    const center = vertexPosition(vertex, 'Arc');
    const radiusNode = child(vertex, 'valRadiusArc');
    if (radiusNode == null) throw new Error('Arc vertex without radius');
    const declaredRadius = radiusToMeters45(radiusNode.text, text(vertex, 'uomRadiusArc'));

    const start = inverse(center, from);
    const end = inverse(center, to);

    let sweep = end.azimuthDegrees - start.azimuthDegrees;
    if (clockwise) while (sweep <= 0) sweep += 360;
    else while (sweep >= 0) sweep -= 360;

    // A full circle is encoded as an arc whose start and end coincide; the sweep then
    // comes out as ~0 and has to become a complete turn.
    if (Math.abs(sweep) < 1e-6) sweep = clockwise ? 360 : -360;

    const startRadius = Number.isFinite(start.distanceMeters) ? start.distanceMeters : declaredRadius;
    const endRadius = Number.isFinite(end.distanceMeters) ? end.distanceMeters : declaredRadius;

    const steps = Math.max(2, Math.ceil((Math.abs(sweep) / 360) * config.geometryDetail));
    const coordinates = [];
    for (let step = 1; step < steps; step++) {
        const fraction = step / steps;
        coordinates.push(
            destination(
                center,
                start.azimuthDegrees + sweep * fraction,
                startRadius + (endRadius - startRadius) * fraction
            )
        );
    }

    return coordinates;
}

/**
 * Follows a referenced national border from one ring vertex to the next.
 *
 * @return {number[][]} intermediate points, excluding both end points
 */
function borderCoordinates(vertex, from, to, context, usedBorders) {
    const uid = child(vertex, 'GbrUid');
    const mid = uid?.attrs?.mid;
    const border = mid == null ? null : context.geoBorders.get(mid);
    if (border == null) throw new Error(`Referenced GeoBorder '${text(uid, 'txtName') ?? mid}' not found`);
    usedBorders.push(border.name ?? mid);

    // clipBorder returns the run including both anchors; the caller already emitted the
    // start vertex and will emit the end vertex on the next iteration.
    return clipBorder(border.coordinates, from, to).slice(1, -1);
}

/**
 * Splits a ring that returns to an earlier vertex into its separate loops.
 *
 * A few borders in the SIA data set are published as one vertex list that visits the
 * same coordinate twice - two lobes touching at a point, e.g. `TF25` (positions 0/5 and
 * 6/10) or the Strasbourg sectors `LFSTSC3` and `LFSTSU4`. That is not a simple polygon:
 * turf refuses it ("may not have duplicate vertices") and the airspace would be lost.
 * The lobes are real area, so they are separated and emitted as a MultiPolygon rather
 * than dropped or silently repaired.
 *
 * @param {number[][]} coordinates - not yet closed
 * @return {number[][][]} one or more closed rings
 */
function splitPinchedRing(coordinates) {
    const key = (position) => `${position[0].toFixed(9)},${position[1].toFixed(9)}`;
    const rings = [];
    const stack = [];
    const seen = new Map();

    for (const position of coordinates) {
        const positionKey = key(position);
        const start = seen.get(positionKey);
        if (start == null) {
            seen.set(positionKey, stack.length);
            stack.push(position);
            continue;
        }

        // close the loop that starts at the earlier occurrence
        const loop = stack.splice(start);
        for (const dropped of loop) seen.delete(key(dropped));
        seen.set(positionKey, stack.length);
        stack.push(loop[0]);
        if (loop.length >= 3) rings.push([...loop, [...loop[0]]]);
    }

    if (stack.length >= 3) rings.push([...stack, [...stack[0]]]);

    return rings;
}

/**
 * @param {number[][]} coordinates
 * @param {number} toleranceMeters
 * @return {number[][]}
 */
function dropAdjacentDuplicates(coordinates, toleranceMeters) {
    const cleaned = [coordinates[0]];
    for (const coordinate of coordinates.slice(1)) {
        if (distanceMeters(cleaned.at(-1), coordinate) > toleranceMeters) cleaned.push(coordinate);
    }

    return cleaned;
}

/**
 * @return {Object}
 */
function largestPolygon(collection) {
    let largest = null;
    let largestArea = -1;
    for (const feature of collection.features) {
        const featureArea = area(feature);
        if (featureArea > largestArea) {
            largestArea = featureArea;
            largest = feature;
        }
    }
    if (largest == null) throw new Error('Failed to repair self-intersecting ring');

    return largest;
}
