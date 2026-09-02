import fs from 'node:fs';
import Ajv from 'ajv/dist/2020.js';

const SCHEMA = JSON.parse(fs.readFileSync(new URL('../schemas/geojson-schema.json', import.meta.url)));

/**
 * Validates a converted FeatureCollection against the output schema.
 *
 * @param {Object} geojson
 * @return {{valid: boolean, errors: Object[]}}
 */
export function validateGeojson(geojson) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(SCHEMA);
    const valid = validate(geojson);

    return { valid, errors: validate.errors ?? [] };
}
