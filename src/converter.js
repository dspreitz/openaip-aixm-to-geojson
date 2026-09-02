import { area, difference, featureCollection, intersect, kinks, union, unkinkPolygon } from '@turf/turf';
import { child, children, path, text } from './xml.js';
import { curveToCoordinates, surfaceToRing } from './geometry.js';
import { mapAirspaceMetadata } from './mappings.js';
import { createVerticalLimit } from './units.js';

const DEFAULT_CONFIG = {
    // number of points used for a full 360 degree circle
    geometryDetail: 180,
    // coordinates closer than this to their predecessor are dropped
    joinToleranceMeters: 5,
    // repair self-intersecting rings instead of rejecting the airspace
    fixGeometries: true,
};

const UUID_PREFIX = 'urn:uuid:';

/**
 * Converts an AIXM 5.1.1 BasicMessage containing airspace data into a GeoJSON FeatureCollection.
 * Handles both DFS encodings: stroked borders (all coordinates inline) and referenced borders
 * (national borders referenced as GeoBorder features).
 *
 * @param {Object[]} parsedXml
 * @param {Object} [userConfig]
 * @return {{geojson: Object, stats: Object}}
 */
export function convertAirspaces(parsedXml, userConfig) {
    const config = { ...DEFAULT_CONFIG, ...userConfig };
    const stats = createStats();

    const message = parsedXml.find((node) => node.name === 'message:AIXMBasicMessage');
    if (message == null) throw new Error("Not an AIXM message: missing 'message:AIXMBasicMessage'");

    const airspaceNodes = new Map();
    const borders = new Map();

    for (const member of children(message, 'message:hasMember')) {
        const feature = member.children[0];
        if (feature == null) continue;
        stats.members[feature.name] = (stats.members[feature.name] ?? 0) + 1;

        const identifier = text(feature, 'gml:identifier');
        if (identifier == null) continue;

        if (feature.name === 'aixm:Airspace') {
            airspaceNodes.set(identifier, feature);
        } else if (feature.name === 'aixm:GeoBorder') {
            const timeSlice = path(feature, 'aixm:timeSlice', 'aixm:GeoBorderTimeSlice');
            const curve = path(timeSlice, 'aixm:border', 'aixm:Curve') ?? path(timeSlice, 'aixm:border', 'gml:Curve');
            if (curve == null) continue;
            borders.set(`${UUID_PREFIX}${identifier}`, {
                name: text(timeSlice, 'aixm:name'),
                coordinates: curveToCoordinates(curve),
            });
        }
        // SignificantPointInAirspace is reference data and not needed to build the rings.
    }

    stats.borders.available = borders.size;

    const context = { airspaceNodes, borders, config, stats, geometryCache: new Map() };
    const features = [];
    for (const [identifier, airspaceNode] of airspaceNodes) {
        try {
            features.push(createFeature(identifier, airspaceNode, context));
            stats.converted++;
        } catch (e) {
            stats.failed++;
            stats.failures[e.message] = (stats.failures[e.message] ?? 0) + 1;
            if (stats.failureSamples.length < 15) stats.failureSamples.push(`${identOf(airspaceNode)}: ${e.message}`);
        }
    }

    return { geojson: featureCollection(features), stats };
}

/**
 * @return {Object}
 */
function createStats() {
    return {
        members: {},
        converted: 0,
        failed: 0,
        failures: {},
        failureSamples: [],
        parts: {},
        aggregated: 0,
        partialAggregations: [],
        limitsFromContributors: 0,
        multiPolygons: 0,
        selfIntersecting: 0,
        repaired: 0,
        unmapped: {},
        borders: { available: 0, used: {}, ringsUsingBorders: 0 },
        joinGaps: { max: 0, over10m: 0, over100m: 0, worst: null },
    };
}

/**
 * @param {Object} airspaceNode
 * @return {string}
 */
function identOf(airspaceNode) {
    const timeSlice = path(airspaceNode, 'aixm:timeSlice', 'aixm:AirspaceTimeSlice');

    return `${text(timeSlice, 'aixm:designator') ?? '-'} ${text(timeSlice, 'aixm:name') ?? '-'}`.trim();
}

/**
 * @return {Object}
 */
function createFeature(identifier, airspaceNode, context) {
    const { stats } = context;
    const timeSlice = path(airspaceNode, 'aixm:timeSlice', 'aixm:AirspaceTimeSlice');
    if (timeSlice == null) throw new Error("Missing 'aixm:AirspaceTimeSlice'");

    const activation = path(timeSlice, 'aixm:activation', 'aixm:AirspaceActivation');
    const metadata = mapAirspaceMetadata({
        type: text(timeSlice, 'aixm:type'),
        localType: text(timeSlice, 'aixm:localType'),
        airspaceClass: text(timeSlice, 'aixm:class', 'aixm:AirspaceLayerClass', 'aixm:classification'),
        activity: text(activation, 'aixm:activity'),
    });
    for (const value of metadata.unmapped) stats.unmapped[value] = (stats.unmapped[value] ?? 0) + 1;

    const { upperCeiling, lowerCeiling } = resolveVerticalLimits(identifier, context, new Set());
    const geometry = buildGeometry(identifier, context, new Set());
    if (geometry.type === 'MultiPolygon') stats.multiPolygons++;

    const name = text(timeSlice, 'aixm:name') ?? text(timeSlice, 'aixm:designator');
    if (name == null) throw new Error('Missing airspace name');

    return {
        type: 'Feature',
        // The AIXM UUID is stable across AIRAC cycles - it is the key that makes an
        // incremental update possible instead of a wipe/create import.
        id: identifier,
        properties: {
            name,
            type: metadata.type,
            class: metadata.class,
            activity: metadata.activity,
            upperCeiling,
            lowerCeiling,
            // AIXM models NOTAM activation through aixm:activation/@status and timesheets; the
            // DFS snapshot carries permanent activations only.
            activatedByNotam: false,
        },
        geometry,
    };
}

/**
 * @param {Object} timeSlice
 * @return {Object[]}
 */
function geometryComponents(timeSlice) {
    return children(timeSlice, 'aixm:geometryComponent')
        .map((component) => child(component, 'aixm:AirspaceGeometryComponent'))
        .filter((component) => component != null);
}

/**
 * @param {Object} volume
 * @return {string|null} referenced airspace UUID, or null if the reference is not resolvable
 */
function contributorReference(volume) {
    const reference = path(volume, 'aixm:contributorAirspace', 'aixm:AirspaceVolumeDependency', 'aixm:theAirspace');
    const href = reference?.attrs?.['xlink:href'];
    if (href == null) return null;

    return href.startsWith(UUID_PREFIX) ? href.slice(UUID_PREFIX.length) : null;
}

/**
 * @param {Object} volume
 * @return {Object|null}
 */
function volumeSurface(volume) {
    return path(volume, 'aixm:horizontalProjection', 'aixm:Surface');
}

/**
 * @param {{value: number, unit: string}} limit
 * @return {number} roughly comparable altitude in feet
 */
function toComparableFeet(limit) {
    return limit.unit === 'FL' ? limit.value * 100 : limit.value;
}

/**
 * Resolves the vertical limits of an airspace.
 *
 * Aggregating airspaces (e.g. "LANGEN CTA ALL") carry `xsi:nil` limits - the extent lives in
 * the contributing airspaces. In that case the envelope of the contributors is used:
 * the lowest lower limit and the highest upper limit.
 *
 * @return {{upperCeiling: Object, lowerCeiling: Object}}
 */
function resolveVerticalLimits(identifier, context, visiting) {
    if (visiting.has(identifier)) throw new Error('Circular airspace volume dependency');
    visiting.add(identifier);

    const airspaceNode = context.airspaceNodes.get(identifier);
    if (airspaceNode == null) throw new Error(`Referenced airspace '${identifier}' not found in message`);

    const timeSlice = path(airspaceNode, 'aixm:timeSlice', 'aixm:AirspaceTimeSlice');
    const components = geometryComponents(timeSlice);
    if (components.length === 0) throw new Error("Missing 'aixm:geometryComponent'");

    const base = components.find((component) => text(component, 'aixm:operation') === 'BASE') ?? components[0];
    const baseVolume = path(base, 'aixm:theAirspaceVolume', 'aixm:AirspaceVolume');
    if (baseVolume == null) throw new Error("Missing 'aixm:AirspaceVolume'");

    if (child(baseVolume, 'aixm:upperLimit')?.text != null) {
        return {
            upperCeiling: createVerticalLimit(
                child(baseVolume, 'aixm:upperLimit'),
                child(baseVolume, 'aixm:upperLimitReference')
            ),
            lowerCeiling: createVerticalLimit(
                child(baseVolume, 'aixm:lowerLimit'),
                child(baseVolume, 'aixm:lowerLimitReference')
            ),
        };
    }

    let upperCeiling = null;
    let lowerCeiling = null;
    for (const component of components) {
        const volume = path(component, 'aixm:theAirspaceVolume', 'aixm:AirspaceVolume');
        const reference = volume == null ? null : contributorReference(volume);
        if (reference == null) continue;

        let contributor;
        try {
            contributor = resolveVerticalLimits(reference, context, visiting);
        } catch {
            continue;
        }
        if (upperCeiling == null || toComparableFeet(contributor.upperCeiling) > toComparableFeet(upperCeiling)) {
            upperCeiling = contributor.upperCeiling;
        }
        if (lowerCeiling == null || toComparableFeet(contributor.lowerCeiling) < toComparableFeet(lowerCeiling)) {
            lowerCeiling = contributor.lowerCeiling;
        }
    }

    visiting.delete(identifier);
    if (upperCeiling == null || lowerCeiling == null) throw new Error('Missing vertical limits');
    context.stats.limitsFromContributors++;

    return { upperCeiling, lowerCeiling };
}

/**
 * Builds the horizontal geometry of an airspace.
 *
 * An airspace either carries its own `aixm:Surface`, or it is an aggregation: a BASE
 * component plus UNION components, each referencing another airspace. Those are resolved
 * recursively and unioned.
 *
 * @return {Object}
 */
function buildGeometry(identifier, context, visiting) {
    const { airspaceNodes, geometryCache, stats } = context;
    if (geometryCache.has(identifier)) return geometryCache.get(identifier);
    if (visiting.has(identifier)) throw new Error('Circular airspace volume dependency');
    visiting.add(identifier);

    const airspaceNode = airspaceNodes.get(identifier);
    if (airspaceNode == null) throw new Error(`Referenced airspace '${identifier}' not found in message`);

    const timeSlice = path(airspaceNode, 'aixm:timeSlice', 'aixm:AirspaceTimeSlice');
    const parts = [];
    let isAggregation = false;
    let droppedContributors = 0;

    for (const component of orderedGeometryComponents(timeSlice)) {
        const volume = path(component, 'aixm:theAirspaceVolume', 'aixm:AirspaceVolume');
        if (volume == null) continue;

        const operation = text(component, 'aixm:operation') ?? 'BASE';
        const surface = volumeSurface(volume);
        if (surface != null) {
            parts.push({ operation, feature: polygonFromSurface(surface, context, identOf(airspaceNode)) });
            continue;
        }

        isAggregation = true;
        const reference = contributorReference(volume);
        if (reference == null) {
            // Cross-border airspaces reference the foreign part with an abstract
            // `urn:aixm:Airspace(...)` key that is not contained in the German data set.
            droppedContributors++;
            continue;
        }

        try {
            parts.push({
                operation,
                feature: { type: 'Feature', properties: {}, geometry: buildGeometry(reference, context, visiting) },
            });
        } catch (e) {
            if (e.message.includes('not found in message') === false) throw e;
            droppedContributors++;
        }
    }

    if (parts.length === 0) throw new Error('Airspace has no usable geometry component');
    if (isAggregation) stats.aggregated++;
    if (droppedContributors > 0) {
        stats.partialAggregations.push(`${identOf(airspaceNode)} (${droppedContributors} contributor(s) not in file)`);
    }

    const geometry = applyOperations(parts);
    if (geometry == null) throw new Error('Combining the contributor airspaces produced no geometry');

    visiting.delete(identifier);
    geometryCache.set(identifier, geometry);

    return geometry;
}

/**
 * AIXM combines the geometry components of an aggregating airspace as an ordered sequence:
 * a BASE component followed by UNION / SUBTR / INTERS operations, ordered by
 * `aixm:operationSequence`. Applying them in that order - rather than unioning everything at
 * once - is what the model prescribes and it also merges adjacent contributors reliably.
 *
 * @param {Object[]} parts
 * @return {Object|null}
 */
function applyOperations(parts) {
    let combined = null;
    for (const { operation, feature } of parts) {
        if (combined == null || operation === 'BASE') {
            combined = feature;
            continue;
        }

        const pair = featureCollection([combined, feature]);
        switch (operation) {
            case 'UNION':
                combined = union(pair) ?? combined;
                break;
            case 'SUBTR':
                combined = difference(pair) ?? combined;
                break;
            case 'INTERS':
                combined = intersect(pair) ?? combined;
                break;
            default:
                throw new Error(`Unsupported geometry component operation '${operation}'`);
        }
    }

    return combined?.geometry ?? null;
}

/**
 * @param {Object} timeSlice
 * @return {Object[]}
 */
function orderedGeometryComponents(timeSlice) {
    return geometryComponents(timeSlice)
        .map((component, index) => ({
            component,
            sequence: Number.parseInt(text(component, 'aixm:operationSequence') ?? String(index + 1), 10),
        }))
        .sort((a, b) => a.sequence - b.sequence)
        .map((entry) => entry.component);
}

/**
 * @return {Object}
 */
function polygonFromSurface(surface, context, ident) {
    const { borders, config, stats } = context;
    const { coordinates, usedBorders, maxJoinGapMeters, segmentKinds } = surfaceToRing(surface, { borders, config });

    for (const [kind, count] of Object.entries(segmentKinds)) stats.parts[kind] = (stats.parts[kind] ?? 0) + count;
    if (usedBorders.length > 0) {
        stats.borders.ringsUsingBorders++;
        for (const href of usedBorders) {
            const name = borders.get(href)?.name ?? href;
            stats.borders.used[name] = (stats.borders.used[name] ?? 0) + 1;
        }
    }

    if (maxJoinGapMeters > 10) stats.joinGaps.over10m++;
    if (maxJoinGapMeters > 100) stats.joinGaps.over100m++;
    if (maxJoinGapMeters > stats.joinGaps.max) {
        stats.joinGaps.max = maxJoinGapMeters;
        stats.joinGaps.worst = ident;
    }

    let polygon = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coordinates] } };
    if (kinks(polygon).features.length > 0) {
        stats.selfIntersecting++;
        if (config.fixGeometries === false) throw new Error('Self-intersecting ring');
        polygon = largestPolygon(unkinkPolygon(polygon));
        stats.repaired++;
    }

    return polygon;
}

/**
 * Self-intersections in this dataset are slivers where a segment overshoots the next vertex;
 * keeping the largest part discards the sliver, not the airspace.
 *
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
