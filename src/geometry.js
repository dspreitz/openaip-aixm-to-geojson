import { child, children, path, text } from './xml.js';
import { destination, distanceMeters, inverse } from './geodesic.js';
import { radiusToMeters } from './units.js';

/*
 AIXM/GML uses the axis order defined by the CRS. EPSG:4326 is LAT/LON - the opposite of
 the GeoJSON [lon, lat] order. Getting this wrong silently moves Germany into the Indian
 Ocean, so the CRS is resolved explicitly rather than assumed.
*/
const LAT_LON_CRS = new Set([
    'urn:ogc:def:crs:EPSG::4326',
    'urn:ogc:def:crs:EPSG:6.15:4326',
    'http://www.opengis.net/def/crs/EPSG/0/4326',
    'EPSG:4326',
]);
const LON_LAT_CRS = new Set(['urn:ogc:def:crs:OGC:1.3:CRS84', 'http://www.opengis.net/def/crs/OGC/1.3/CRS84', 'CRS84']);

/**
 * @param {string|null} srsName
 * @return {boolean}
 */
export function isLatLonOrder(srsName) {
    if (srsName == null) return true; // AIXM default is EPSG:4326 => lat/lon
    if (LAT_LON_CRS.has(srsName)) return true;
    if (LON_LAT_CRS.has(srsName)) return false;

    throw new Error(`Unsupported CRS '${srsName}'`);
}

/**
 * @param {string} value
 * @param {boolean} latLonOrder
 * @return {number[][]}
 */
function parseCoordinateList(value, latLonOrder) {
    const parts = value.trim().split(/\s+/).map(Number.parseFloat);
    if (parts.length === 0 || parts.length % 2 !== 0) throw new Error(`Invalid coordinate list '${value}'`);

    const coordinates = [];
    for (let idx = 0; idx < parts.length; idx += 2) {
        const [first, second] = [parts[idx], parts[idx + 1]];
        if (Number.isFinite(first) === false || Number.isFinite(second) === false) {
            throw new Error(`Invalid coordinate list '${value}'`);
        }
        coordinates.push(latLonOrder ? [second, first] : [first, second]);
    }

    return coordinates;
}

/**
 * Reads all `gml:pos` and `gml:posList` children of a node in document order.
 *
 * @param {Object} node
 * @param {boolean} latLonOrder
 * @return {number[][]}
 */
function readPositions(node, latLonOrder) {
    const coordinates = [];
    for (const positionNode of node.children) {
        if (positionNode.name !== 'gml:pos' && positionNode.name !== 'gml:posList') continue;
        if (positionNode.text == null) throw new Error(`Empty '${positionNode.name}' element`);
        coordinates.push(...parseCoordinateList(positionNode.text, latLonOrder));
    }

    return coordinates;
}

/**
 * Reads the coordinates of every curve segment of an `aixm:Curve` / `gml:Curve`.
 * Used for GeoBorder curves, which are plain polylines.
 *
 * @param {Object} curve
 * @return {number[][]}
 */
export function curveToCoordinates(curve) {
    const latLonOrder = isLatLonOrder(curve.attrs?.srsName ?? null);
    const segments = child(curve, 'gml:segments');
    if (segments == null) throw new Error("Curve without 'gml:segments'");

    const coordinates = [];
    for (const segment of segments.children) {
        if (segment.name !== 'gml:GeodesicString' && segment.name !== 'gml:LineStringSegment') {
            throw new Error(`Unsupported segment '${segment.name}' in curve`);
        }
        coordinates.push(...readPositions(segment, latLonOrder));
    }

    return coordinates;
}

/**
 * Builds a full circle from a `gml:CircleByCenterPoint`.
 *
 * @param {Object} segment
 * @param {boolean} latLonOrder
 * @param {Object} config
 * @return {number[][]}
 */
function circleCoordinates(segment, latLonOrder, config) {
    const [center] = readPositions(segment, latLonOrder);
    if (center == null) throw new Error("Missing center point in 'gml:CircleByCenterPoint'");

    const radius = radiusToMeters(child(segment, 'gml:radius'));
    const coordinates = [];
    for (let step = 0; step < config.geometryDetail; step++) {
        coordinates.push(destination(center, (360 * step) / config.geometryDetail, radius));
    }
    coordinates.push([...coordinates[0]]);

    return coordinates;
}

/**
 * @param {Object} segment
 * @param {boolean} latLonOrder
 * @return {{center: number[], radius: number, startAngle: number, endAngle: number}}
 */
function readArc(segment, latLonOrder) {
    const [center] = readPositions(segment, latLonOrder);
    if (center == null) throw new Error("Missing center point in 'gml:ArcByCenterPoint'");

    const startAngle = Number.parseFloat(text(segment, 'gml:startAngle'));
    const endAngle = Number.parseFloat(text(segment, 'gml:endAngle'));
    if (Number.isFinite(startAngle) === false || Number.isFinite(endAngle) === false) {
        throw new Error("Invalid start/end angle in 'gml:ArcByCenterPoint'");
    }

    return { center, radius: radiusToMeters(child(segment, 'gml:radius')), startAngle, endAngle };
}

/**
 * Builds an arc from a `gml:ArcByCenterPoint`.
 *
 * Two rules from the AIXM Coding Guidelines ("Arc by Centre Point") drive this:
 *
 * 1. Angles are bearings measured clockwise from true north, and the sweep direction is
 *    the SIGN of (endAngle - startAngle): clockwise when startAngle < endAngle,
 *    counter-clockwise when startAngle > endAngle (for a latitude-first CRS such as
 *    EPSG:4326). Normalising the sweep to a positive value draws 39 % of the arcs in the
 *    DFS dataset the wrong way round.
 * 2. The construct is over-specified - "the calculated distance from the centre to the
 *    start and end point is not quite the same due to round-off error and is also usually
 *    different from the radius". The neighbouring ring vertices are therefore authoritative:
 *    the arc is re-based onto them and its radius is interpolated between the two measured
 *    radii, so it joins the ring exactly instead of leaving a gap.
 *
 * @param {Object} segment
 * @param {boolean} latLonOrder
 * @param {Object} options
 * @param {number[]|null} options.entryPoint - preceding ring vertex, if any
 * @param {number[]|null} options.exitPoint - following ring vertex, if any
 * @param {Object} options.config
 * @return {number[][]}
 */
function arcCoordinates(segment, latLonOrder, { entryPoint, exitPoint, config }) {
    const { center, radius, startAngle, endAngle } = readArc(segment, latLonOrder);
    const declaredSweep = endAngle - startAngle;

    let startAzimuth = startAngle;
    let startRadius = radius;
    if (entryPoint != null) {
        const measured = inverse(center, entryPoint);
        startAzimuth = measured.azimuthDegrees;
        startRadius = measured.distanceMeters;
    }

    let endAzimuth = endAngle;
    let endRadius = radius;
    if (exitPoint != null) {
        const measured = inverse(center, exitPoint);
        endAzimuth = measured.azimuthDegrees;
        endRadius = measured.distanceMeters;
    }

    // Re-based azimuths come back in [-180, 180]; shift the sweep by full turns until it
    // matches the direction and magnitude declared in the source.
    let sweep = endAzimuth - startAzimuth;
    while (sweep - declaredSweep > 180) sweep -= 360;
    while (declaredSweep - sweep > 180) sweep += 360;

    const steps = Math.max(2, Math.ceil((Math.abs(sweep) / 360) * config.geometryDetail));
    const coordinates = [];
    for (let step = 0; step <= steps; step++) {
        const fraction = step / steps;
        coordinates.push(
            destination(center, startAzimuth + sweep * fraction, startRadius + (endRadius - startRadius) * fraction)
        );
    }

    return coordinates;
}

/**
 * The point an arc starts at according to its own radius/angle - used as an anchor when an
 * arc directly follows a GeoBorder reference and no explicit vertex sits between them.
 *
 * @param {Object} segment
 * @param {boolean} latLonOrder
 * @return {{start: number[], end: number[]}}
 */
function declaredArcEnds(segment, latLonOrder) {
    const { center, radius, startAngle, endAngle } = readArc(segment, latLonOrder);

    return { start: destination(center, startAngle, radius), end: destination(center, endAngle, radius) };
}

/**
 * Splits a ring into an ordered list of parts. A part is either already resolved
 * (`coordinates`) or deferred because it can only be built once its neighbours are known:
 * arcs need the adjacent vertices, GeoBorder references need to know where to clip.
 *
 * @param {Object} ring
 * @param {Object} config
 * @return {Object[]}
 */
function ringParts(ring, config) {
    const parts = [];
    for (const curveMember of children(ring, 'gml:curveMember')) {
        const href = curveMember.attrs?.['xlink:href'];
        if (href != null) {
            parts.push({ kind: 'border', href });
            continue;
        }

        const curve = child(curveMember, 'gml:Curve') ?? child(curveMember, 'aixm:Curve');
        if (curve == null) throw new Error("Curve member without 'gml:Curve' and without xlink:href");

        const latLonOrder = isLatLonOrder(curve.attrs?.srsName ?? null);
        const segments = child(curve, 'gml:segments');
        if (segments == null) throw new Error("Curve without 'gml:segments'");

        for (const segment of segments.children) {
            switch (segment.name) {
                // Great circle vs. straight in projection - at airspace scale the difference is
                // far below the accuracy of the source data, so both are read as vertices.
                case 'gml:GeodesicString':
                case 'gml:LineStringSegment':
                    parts.push({ kind: 'fixed', coordinates: readPositions(segment, latLonOrder) });
                    break;
                case 'gml:CircleByCenterPoint':
                    parts.push({ kind: 'fixed', coordinates: circleCoordinates(segment, latLonOrder, config) });
                    break;
                case 'gml:ArcByCenterPoint':
                    parts.push({ kind: 'arc', segment, latLonOrder, ends: declaredArcEnds(segment, latLonOrder) });
                    break;
                default:
                    throw new Error(`Unsupported curve segment '${segment.name}'`);
            }
        }
    }

    return parts.filter((part) => part.kind !== 'fixed' || part.coordinates.length > 0);
}

/**
 * Finds the point on a polyline closest to a target - not the closest vertex.
 *
 * That distinction matters: where a national border runs out to sea it is often a single
 * long straight segment, and the point at which an airspace boundary joins it lies in the
 * middle of that segment. Snapping to the nearest vertex instead put the join up to 28 km
 * off (OSTSEE 1 on the DE/PL maritime border).
 *
 * Projection uses a local equirectangular frame around the target, which is exact enough
 * over a single border segment.
 *
 * @param {number[][]} coordinates
 * @param {number[]} target
 * @return {{index: number, fraction: number, point: number[], distanceMeters: number}}
 */
function nearestOnPolyline(coordinates, target) {
    const scale = Math.cos((target[1] * Math.PI) / 180);
    let best = { index: 0, fraction: 0, point: coordinates[0], distanceMeters: Infinity };

    for (let index = 0; index < coordinates.length - 1; index++) {
        const [start, end] = [coordinates[index], coordinates[index + 1]];
        const dx = (end[0] - start[0]) * scale;
        const dy = end[1] - start[1];
        const lengthSquared = dx * dx + dy * dy;

        let fraction = 0;
        if (lengthSquared > 0) {
            const tx = (target[0] - start[0]) * scale;
            const ty = target[1] - start[1];
            fraction = Math.min(1, Math.max(0, (tx * dx + ty * dy) / lengthSquared));
        }

        const point = [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction];
        const candidate = distanceMeters(point, target);
        if (candidate < best.distanceMeters) best = { index, fraction, point, distanceMeters: candidate };
    }

    return best;
}

/**
 * Extracts the portion of a border polyline between two anchor points, in the direction
 * implied by them.
 *
 * The AIXM Coding Guidelines state that the referenced GeoBorder "is likely to be much
 * longer, including also points that are beyond the portion used for the current airspace
 * border definition" - which portion is used follows from ISO 19136's requirement that the
 * curves of a ring "shall be contiguous and connected in a cycle", i.e. from the adjacent
 * curve members.
 *
 * @param {number[][]} coordinates
 * @param {number[]} entryPoint
 * @param {number[]} exitPoint
 * @return {number[][]}
 */
function clipBorder(coordinates, entryPoint, exitPoint) {
    const entry = nearestOnPolyline(coordinates, entryPoint);
    const exit = nearestOnPolyline(coordinates, exitPoint);
    const entryPosition = entry.index + entry.fraction;
    const exitPosition = exit.index + exit.fraction;

    // The anchors are explicit AIP coordinates and therefore authoritative; the projections
    // only decide WHICH border vertices lie between them. Using the projected points as the
    // endpoints instead would leave the ring closing a metre or two beside its start vertex,
    // which shows up as a self-intersection.
    const between =
        entryPosition <= exitPosition
            ? coordinates.slice(entry.index + 1, exit.index + 1)
            : coordinates.slice(exit.index + 1, entry.index + 1).reverse();

    return [entryPoint, ...between, exitPoint];
}

/**
 * @param {number[][]} coordinates
 * @param {number[][]} other
 * @return {number}
 */
function distanceToNearestEnd(position, other) {
    return Math.min(distanceMeters(position, other[0]), distanceMeters(position, other.at(-1)));
}

/**
 * Resolves a run of consecutive GeoBorder references.
 *
 * A single reference is clipped between its two anchors. In a chain - an airspace boundary
 * that follows several national borders in sequence, e.g. DE/NL then BE/DE - only the first
 * and last border are partial; the ones in between are traversed completely, oriented so
 * that the chain stays connected.
 *
 * @return {number[][]}
 */
function resolveBorderRun(run, entryPoint, exitPoint, borders) {
    // DFS splits a single stretch of border into several curve members that all reference the
    // same GeoBorder. Consecutive references to the same border are one continuous run - not
    // repeated traversals of the whole border.
    const collapsed = run.filter((part, index) => index === 0 || part.href !== run[index - 1].href);

    const curves = collapsed.map((part) => {
        const border = borders.get(part.href);
        if (border == null) throw new Error(`Referenced GeoBorder '${part.href}' not found in message`);

        return border;
    });

    if (curves.length === 1) return clipBorder(curves[0].coordinates, entryPoint, exitPoint);

    const coordinates = [];
    let current = entryPoint;
    for (let index = 0; index < curves.length; index++) {
        const { coordinates: border } = curves[index];
        if (index === curves.length - 1) {
            const piece = clipBorder(border, current, exitPoint);
            coordinates.push(...piece);
            break;
        }

        // traverse this border completely, entering at the end closest to the current point
        // and leaving at the end that continues towards the next border
        const next = curves[index + 1].coordinates;
        const forward = distanceToNearestEnd(border.at(-1), next) <= distanceToNearestEnd(border[0], next);
        const entry = nearestOnPolyline(border, current);
        const piece = forward
            ? [current, ...border.slice(entry.index + 1)]
            : [current, ...border.slice(0, entry.index + 1).reverse()];
        coordinates.push(...piece);
        current = piece.at(-1);
    }

    return coordinates;
}

/**
 * Builds the exterior ring of an `aixm:Surface`.
 *
 * @param {Object} surface
 * @param {Object} context
 * @param {Map} context.borders - GeoBorder coordinates by `urn:uuid:` reference
 * @param {Object} context.config
 * @return {{coordinates: number[][], usedBorders: string[], maxJoinGapMeters: number, segmentKinds: Object}}
 */
export function surfaceToRing(surface, { borders, config }) {
    const patch = path(surface, 'gml:patches', 'gml:PolygonPatch');
    if (patch == null) throw new Error("Unsupported surface: no 'gml:PolygonPatch'");
    if (child(patch, 'gml:interior') != null) throw new Error('Unsupported surface: ring has interior holes');

    const ring = path(patch, 'gml:exterior', 'gml:Ring');
    if (ring == null) throw new Error("Unsupported surface: no 'gml:exterior/gml:Ring'");

    const parts = ringParts(ring, config);
    if (parts.length === 0) throw new Error('Ring has no curve members');

    // Deferred parts are anchored on their neighbours, so the walk has to start on a part
    // that is already resolved.
    const firstFixed = parts.findIndex((part) => part.kind === 'fixed');
    if (firstFixed === -1) throw new Error('Ring consists solely of arcs and border references');
    const ordered = [...parts.slice(firstFixed), ...parts.slice(0, firstFixed)];

    const segmentKinds = {};
    const usedBorders = [];
    let coordinates = [];
    let maxJoinGapMeters = 0;

    const append = (pieceCoordinates) => {
        if (pieceCoordinates.length === 0) return;
        if (coordinates.length > 0) {
            const gap = distanceMeters(coordinates.at(-1), pieceCoordinates[0]);
            if (gap > maxJoinGapMeters) maxJoinGapMeters = gap;
        }
        coordinates.push(...pieceCoordinates);
    };

    /**
     * The anchor a deferred part ends on: the start of the next resolved part, looking past
     * further deferred parts.
     */
    const anchorAfter = (index) => {
        for (let offset = 1; offset <= ordered.length; offset++) {
            const part = ordered[(index + offset) % ordered.length];
            if (part.kind === 'fixed') return part.coordinates[0];
            if (part.kind === 'arc') return part.ends.start;
        }

        return null;
    };

    for (let index = 0; index < ordered.length; index++) {
        const part = ordered[index];
        segmentKinds[part.kind] = (segmentKinds[part.kind] ?? 0) + 1;

        if (part.kind === 'fixed') {
            append(part.coordinates);
            continue;
        }

        if (part.kind === 'arc') {
            append(
                arcCoordinates(part.segment, part.latLonOrder, {
                    entryPoint: coordinates.at(-1) ?? null,
                    exitPoint: anchorAfter(index),
                    config,
                })
            );
            continue;
        }

        // collect the maximal run of consecutive border references
        const run = [part];
        while (ordered[index + 1]?.kind === 'border') run.push(ordered[++index]);
        for (const borderPart of run) usedBorders.push(borderPart.href);
        append(resolveBorderRun(run, coordinates.at(-1), anchorAfter(index), borders));
    }

    if (coordinates.length < 3) throw new Error(`Ring has only ${coordinates.length} coordinates`);

    coordinates = dropAdjacentDuplicates(coordinates, config.joinToleranceMeters);
    if (distanceMeters(coordinates[0], coordinates.at(-1)) > 0) coordinates.push([...coordinates[0]]);
    if (coordinates.length < 4) throw new Error(`Ring collapsed to ${coordinates.length} coordinates`);

    return { coordinates, usedBorders, maxJoinGapMeters, segmentKinds };
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
