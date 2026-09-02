import fs from 'node:fs';
import { convertAirspaces } from './src/converter.js';
import { convertAixm45 } from './src/aixm45.js';
import { parseXml } from './src/xml.js';
import { validateGeojson } from './src/validate.js';

export { convertAirspaces, convertAixm45, parseXml, validateGeojson };

/**
 * Detects which AIXM generation a parsed document is.
 *
 * The two are told apart by their root element, not by a version attribute: AIXM 5.1
 * wraps everything in a `message:AIXMBasicMessage`, AIXM 4.5 in an `AIXM-Snapshot`.
 *
 * @param {Object[]} parsedXml
 * @return {'5.1'|'4.5'}
 */
export function detectAixmVersion(parsedXml) {
    if (parsedXml.some((node) => node.name === 'message:AIXMBasicMessage')) return '5.1';
    if (parsedXml.some((node) => node.name === 'AIXM-Snapshot')) return '4.5';

    throw new Error('Unknown AIXM flavour: neither message:AIXMBasicMessage nor AIXM-Snapshot');
}

/**
 * Converts a parsed AIXM document of either generation.
 *
 * @param {Object[]} parsedXml
 * @param {Object} [config]
 * @return {{geojson: Object, stats: Object, aixmVersion: string}}
 */
export function convert(parsedXml, config) {
    const aixmVersion = detectAixmVersion(parsedXml);
    const result = aixmVersion === '4.5' ? convertAixm45(parsedXml, config) : convertAirspaces(parsedXml, config);

    return { ...result, aixmVersion };
}

/**
 * Reads an AIXM file and converts the airspaces it contains to GeoJSON.
 *
 * @param {string} inputFilepath
 * @param {Object} [config] - see DEFAULT_CONFIG in src/converter.js
 * @return {{geojson: Object, stats: Object, aixmVersion: string}}
 */
export function convertFile(inputFilepath, config) {
    if (fs.existsSync(inputFilepath) === false) throw new Error(`File '${inputFilepath}' does not exist`);

    return convert(parseXml(fs.readFileSync(inputFilepath)), config);
}
