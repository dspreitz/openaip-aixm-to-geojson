import assert from 'node:assert/strict';
import test from 'node:test';
import { bbox } from '@turf/turf';
import { convertFile, validateGeojson } from '../index.js';

/*
 Integration test against the bundled DFS ED_Airspace snapshot. It is the stroked-borders
 encoding, i.e. all national borders are resolved into explicit coordinates.
*/
const FIXTURE = './tests/fixtures/aixm-airspace.xml';

test('converts the bundled DFS airspace snapshot completely', (t) => {
    const { geojson, stats } = convertFile(FIXTURE);

    assert.equal(stats.failed, 0, `${stats.failed} airspaces failed to convert`);
    assert.equal(geojson.features.length, stats.converted);
    assert.equal(stats.converted, stats.members['aixm:Airspace']);
    // no AIXM value silently fell through the type/class/activity mapping
    assert.deepEqual(stats.unmapped, {});

    t.diagnostic(`converted ${stats.converted} airspaces, ${stats.aggregated} of them aggregations`);
});

test('the converted snapshot conforms to the output schema', () => {
    const { geojson } = convertFile(FIXTURE);
    const { valid, errors } = validateGeojson(geojson);

    assert.equal(valid, true, JSON.stringify(errors.slice(0, 3), null, 2));
});

test('the converted snapshot covers Germany', () => {
    const { geojson } = convertFile(FIXTURE);
    const [west, south, east, north] = bbox(geojson);

    // Germany plus the cross-border parts contained in the data set
    assert.ok(west > 5 && west < 7, `unexpected western bound ${west}`);
    assert.ok(east > 14 && east < 16, `unexpected eastern bound ${east}`);
    assert.ok(south > 46 && south < 48, `unexpected southern bound ${south}`);
    assert.ok(north > 54 && north < 56, `unexpected northern bound ${north}`);
});

test('every ring is closed and every airspace carries its AIXM UUID', () => {
    const { geojson } = convertFile(FIXTURE);

    for (const feature of geojson.features) {
        assert.match(feature.id, /^[0-9a-f-]{36}$/);
        const polygons =
            feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
        for (const polygon of polygons) {
            for (const ring of polygon) {
                assert.ok(ring.length >= 4);
                assert.deepEqual(ring[0], ring.at(-1), `unclosed ring in '${feature.properties.name}'`);
            }
        }
    }
});
