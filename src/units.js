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

/*
 AIXM 4.5 additions.

 The 4.5 snapshot uses its own spellings throughout: coordinates as DDMMSS.ss with a
 hemisphere letter instead of decimal degrees, plain unit names instead of UCUM codes,
 and a separate `codeDistVer` element for the reference datum instead of an attribute.
*/

const DMS_PATTERN = /^(\d+(?:\.\d+)?)([NSEW])$/;

/**
 * Converts an AIXM 4.5 coordinate to decimal degrees.
 *
 * The format packs degrees, minutes and seconds without separators and puts the
 * hemisphere last: `491216.00N` is 49 deg 12 min 16 s, `0021100.00E` is 2 deg 11 min.
 * Latitude carries two leading digits for the degrees, longitude three - so the split
 * point follows from the string length, not from the value.
 *
 * @param {string} value
 * @return {number}
 */
export function dmsToDecimal(value) {
    const match = DMS_PATTERN.exec(String(value ?? '').trim());
    if (match == null) throw new Error(`Invalid AIXM 4.5 coordinate '${value}'`);

    const [, digits, hemisphere] = match;
    const degreeDigits = hemisphere === 'N' || hemisphere === 'S' ? 2 : 3;
    if (digits.indexOf('.') !== -1 && digits.indexOf('.') !== degreeDigits + 4) {
        throw new Error(`Invalid AIXM 4.5 coordinate '${value}'`);
    }

    const degrees = Number.parseInt(digits.slice(0, degreeDigits), 10);
    const minutes = Number.parseInt(digits.slice(degreeDigits, degreeDigits + 2), 10);
    const seconds = Number.parseFloat(digits.slice(degreeDigits + 2));
    if ([degrees, minutes, seconds].some((part) => Number.isFinite(part) === false)) {
        throw new Error(`Invalid AIXM 4.5 coordinate '${value}'`);
    }
    if (minutes >= 60 || seconds >= 60) throw new Error(`Invalid AIXM 4.5 coordinate '${value}'`);

    const decimal = degrees + minutes / 60 + seconds / 3600;

    return hemisphere === 'S' || hemisphere === 'W' ? -decimal : decimal;
}

const RADIUS_CONVERTERS_45 = {
    NM: (value) => value * METERS_PER_NAUTICAL_MILE,
    KM: (value) => value * 1000,
    M: (value) => value,
    FT: (value) => value * METERS_PER_FOOT,
};

/**
 * @param {string} value - `valRadiusArc`
 * @param {string} uom - `uomRadiusArc`
 * @return {number}
 */
export function radiusToMeters45(value, uom) {
    const number = Number.parseFloat(value);
    const converter = RADIUS_CONVERTERS_45[uom];

    if (Number.isFinite(number) === false) throw new Error(`Invalid radius value '${value}'`);
    if (converter == null) throw new Error(`Unsupported radius unit '${uom}'`);

    return converter(number);
}

/*
 `codeDistVer` in the SIA data set: ALT (above mean sea level), HEI (above ground),
 STD (standard pressure, i.e. flight level). SFC does not occur.
*/
const REFERENCE_DATUM_MAP_45 = { ALT: 'MSL', HEI: 'GND', STD: 'STD', SFC: 'GND', MSL: 'MSL' };

/**
 * Converts an AIXM 4.5 vertical limit.
 *
 * @param {string|null} value - `valDistVer*`
 * @param {string|null} uom - `uomDistVer*`
 * @param {string|null} reference - `codeDistVer*`
 * @return {{value: number, unit: string, referenceDatum: string}}
 */
export function createVerticalLimit45(value, uom, reference) {
    if (value == null || uom == null) throw new Error('Missing vertical limit value or unit');
    if (reference == null) throw new Error('Missing vertical limit reference datum');

    const referenceDatum = REFERENCE_DATUM_MAP_45[reference];
    if (referenceDatum == null) throw new Error(`Unsupported reference datum '${reference}'`);

    const number = Number.parseFloat(value);
    if (Number.isFinite(number) === false) throw new Error(`Invalid vertical limit value '${value}'`);

    switch (uom) {
        case 'FT':
            return { value: Math.round(number), unit: 'FT', referenceDatum };
        case 'FL':
            return { value: Math.round(number), unit: 'FL', referenceDatum };
        case 'M':
            return { value: Math.round(number / METERS_PER_FOOT), unit: 'FT', referenceDatum };
        default:
            throw new Error(`Unsupported vertical limit unit '${uom}'`);
    }
}
