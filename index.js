import fs from 'node:fs';
import { convertAirspaces } from './src/converter.js';
import { parseXml } from './src/xml.js';
import { validateGeojson } from './src/validate.js';

export { convertAirspaces, parseXml, validateGeojson };

/**
 * Reads an AIXM file and converts the airspaces it contains to GeoJSON.
 *
 * @param {string} inputFilepath
 * @param {Object} [config] - see DEFAULT_CONFIG in src/converter.js
 * @return {{geojson: Object, stats: Object}}
 */
export function convertFile(inputFilepath, config) {
    if (fs.existsSync(inputFilepath) === false) throw new Error(`File '${inputFilepath}' does not exist`);

    return convertAirspaces(parseXml(fs.readFileSync(inputFilepath)), config);
}
