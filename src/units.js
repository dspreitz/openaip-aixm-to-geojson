export const METERS_PER_NAUTICAL_MILE = 1852;
export const METERS_PER_FOOT = 0.3048;

// UCUM codes as used by DFS/AIXM in `gml:radius/@uom`.
const RADIUS_CONVERTERS = {
    '[nmi_i]': (value) => value * METERS_PER_NAUTICAL_MILE,
    NM: (value) => value * METERS_PER_NAUTICAL_MILE,
    M: (value) => value,
    KM: (value) => value * 1000,
    '[ft_i]': (value) => value * METERS_PER_FOOT,
    FT: (value) => value * METERS_PER_FOOT,
};

/**
 * Converts a `gml:radius` element to meters.
 *
 * @param {Object} radiusNode
 * @return {number}
 */
export function radiusToMeters(radiusNode) {
    const uom = radiusNode?.attrs?.uom;
    const value = Number.parseFloat(radiusNode?.text);
    const converter = RADIUS_CONVERTERS[uom];

    if (Number.isFinite(value) === false) throw new Error(`Invalid radius value '${radiusNode?.text}'`);
    if (converter == null) throw new Error(`Unsupported radius unit '${uom}'`);

    return converter(value);
}

/*
 The DFS dataset uses the reference datums SFC, STD, MSL and the two "OTHER" escapes
 below. openAIP only knows GND/STD/MSL.
 */
const REFERENCE_DATUM_MAP = {
    SFC: 'GND',
    GND: 'GND',
    STD: 'STD',
    MSL: 'MSL',
    'OTHER:ALT': 'MSL', // altitude -> above mean sea level
    'OTHER:HEI': 'GND', // height -> above ground
};

/**
 * Converts an AIXM upper/lower limit plus its reference datum into an openAIP vertical limit.
 * Limits given in meters are converted to feet; flight levels are passed through.
 *
 * @param {Object} limitNode - `aixm:upperLimit` or `aixm:lowerLimit`
 * @param {Object} referenceNode - `aixm:upperLimitReference` or `aixm:lowerLimitReference`
 * @return {{value: number, unit: string, referenceDatum: string}}
 */
export function createVerticalLimit(limitNode, referenceNode) {
    const rawValue = limitNode?.text;
    const uom = limitNode?.attrs?.uom;
    const rawReference = referenceNode?.text;

    if (rawValue == null || uom == null) throw new Error('Missing vertical limit value or unit');
    if (rawReference == null) throw new Error('Missing vertical limit reference datum');

    const referenceDatum = REFERENCE_DATUM_MAP[rawReference];
    if (referenceDatum == null) throw new Error(`Unsupported reference datum '${rawReference}'`);

    // "GND" and "UNL" style textual limits do not occur in the DFS dataset but are cheap to guard.
    const value = Number.parseFloat(rawValue);
    if (Number.isFinite(value) === false) throw new Error(`Invalid vertical limit value '${rawValue}'`);

    switch (uom) {
        case 'FT':
            return { value: Math.round(value), unit: 'FT', referenceDatum };
        case 'FL':
            return { value: Math.round(value), unit: 'FL', referenceDatum };
        case 'M':
            return { value: Math.round(value / METERS_PER_FOOT), unit: 'FT', referenceDatum };
        default:
            throw new Error(`Unsupported vertical limit unit '${uom}'`);
    }
}
