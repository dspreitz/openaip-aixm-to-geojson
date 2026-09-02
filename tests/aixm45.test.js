import assert from 'node:assert/strict';
import test from 'node:test';
import { area } from '@turf/turf';
import { convertAixm45, stableUuid } from '../src/aixm45.js';
import { distanceMeters } from '../src/geodesic.js';
import { createVerticalLimit45, dmsToDecimal, radiusToMeters45 } from '../src/units.js';
import { parseXml } from '../src/xml.js';
import { detectAixmVersion } from '../index.js';

/**
 * Wraps vertices into a minimal AIXM 4.5 snapshot.
 */
function snapshot(vertices, extra = '', ase = '') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<AIXM-Snapshot origin="test" version="4.5" effective="2026-09-03T00:00:00.000+02:00">
  <Ase>
    <AseUid mid="100"><codeType>D</codeType><codeId>TEST1</codeId></AseUid>
    <txtName>TEST</txtName>
    <codeDistVerUpper>STD</codeDistVerUpper><valDistVerUpper>100</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
    <codeDistVerLower>HEI</codeDistVerLower><valDistVerLower>0</valDistVerLower><uomDistVerLower>FT</uomDistVerLower>
    ${ase}
  </Ase>
  <Abd>
    <AbdUid mid="200"><AseUid mid="100"><codeType>D</codeType><codeId>TEST1</codeId></AseUid></AbdUid>
    ${vertices}
  </Abd>
  ${extra}
</AIXM-Snapshot>`;
}

function vertex(lat, lon, type = 'GRC', extra = '') {
    return `<Avx><codeType>${type}</codeType><geoLat>${lat}</geoLat><geoLong>${lon}</geoLong>
            <codeDatum>WGE</codeDatum>${extra}</Avx>`;
}

function convert(xml, config) {
    return convertAixm45(parseXml(xml), config);
}

test('the AIXM generation is detected from the root element', () => {
    assert.equal(detectAixmVersion(parseXml(snapshot(vertex('480000.00N', '0070000.00E')))), '4.5');
    assert.throws(() => detectAixmVersion(parseXml('<other/>')), /Unknown AIXM flavour/);
});

test('DDMMSS coordinates are read with the right degree width', () => {
    // latitude has two degree digits, longitude three - the split follows the hemisphere
    assert.ok(Math.abs(dmsToDecimal('491216.00N') - (49 + 12 / 60 + 16 / 3600)) < 1e-9);
    assert.ok(Math.abs(dmsToDecimal('0021100.00E') - (2 + 11 / 60)) < 1e-9);
    assert.ok(Math.abs(dmsToDecimal('0000031.32W') - -(31.32 / 3600)) < 1e-9);
    assert.throws(() => dmsToDecimal('491275.00N'), /Invalid AIXM 4.5 coordinate/);
    assert.throws(() => dmsToDecimal('4912'), /Invalid AIXM 4.5 coordinate/);
});

test('vertical limits and radii use the AIXM 4.5 spellings', () => {
    assert.deepEqual(createVerticalLimit45('100', 'FL', 'STD'), { value: 100, unit: 'FL', referenceDatum: 'STD' });
    assert.deepEqual(createVerticalLimit45('1350', 'FT', 'ALT'), { value: 1350, unit: 'FT', referenceDatum: 'MSL' });
    assert.deepEqual(createVerticalLimit45('0', 'FT', 'HEI'), { value: 0, unit: 'FT', referenceDatum: 'GND' });
    assert.throws(() => createVerticalLimit45('1', 'FT', 'XXX'), /Unsupported reference datum/);
    assert.equal(radiusToMeters45('9', 'NM'), 9 * 1852);
    assert.throws(() => radiusToMeters45('9', 'SM'), /Unsupported radius unit/);
});

test('the feature id is a deterministic UUID over codeType and codeId', () => {
    assert.equal(stableUuid('TMA|LFSB'), stableUuid('TMA|LFSB'));
    assert.notEqual(stableUuid('TMA|LFSB'), stableUuid('CTR|LFSB'));
    assert.match(stableUuid('TMA|LFSB'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('a vertex type describes the segment to the NEXT vertex', () => {
    const { geojson } = convert(
        snapshot(
            vertex('480000.00N', '0070000.00E') +
                vertex('480000.00N', '0080000.00E') +
                vertex('473000.00N', '0080000.00E')
        )
    );
    const [ring] = geojson.features[0].geometry.coordinates;
    // three straight segments -> three vertices plus the closing one, nothing inserted
    assert.equal(ring.length, 4);
    assert.deepEqual(ring[0], ring.at(-1));
});

test('a clockwise arc bulges east, a counter-clockwise arc bulges west', () => {
    const arcExtra =
        '<geoLatArc>480000.00N</geoLatArc><geoLongArc>0070000.00E</geoLongArc>' +
        '<valRadiusArc>10</valRadiusArc><uomRadiusArc>NM</uomRadiusArc>';
    // from due north of the centre to due south of it
    const ring = (type) =>
        convert(snapshot(vertex('481000.00N', '0070000.00E', type, arcExtra) + vertex('475000.00N', '0070000.00E')))
            .geojson.features[0].geometry.coordinates[0];

    const clockwise = ring('CWA');
    const counter = ring('CCA');
    const east = Math.max(...clockwise.map((c) => c[0]));
    const west = Math.min(...counter.map((c) => c[0]));
    assert.ok(east > 7, `clockwise arc should pass east of the centre, got ${east}`);
    assert.ok(west < 7, `counter-clockwise arc should pass west of the centre, got ${west}`);
});

test('an arc is re-based onto the published ring vertices', () => {
    const arcExtra =
        '<geoLatArc>480000.00N</geoLatArc><geoLongArc>0070000.00E</geoLongArc>' +
        '<valRadiusArc>10</valRadiusArc><uomRadiusArc>NM</uomRadiusArc>';
    const { geojson } = convert(
        snapshot(vertex('481000.00N', '0070000.00E', 'CWA', arcExtra) + vertex('475000.00N', '0070000.00E'))
    );
    const [ring] = geojson.features[0].geometry.coordinates;
    // the arc must start and end exactly on the vertices the AIP publishes
    assert.ok(distanceMeters(ring[0], [7, 48 + 10 / 60]) < 1);
    assert.ok(distanceMeters(ring.at(-1), [7, 48 + 10 / 60]) < 1);
});

test('a border reference follows the referenced Gbr between its anchors', () => {
    const border = `<Gbr>
        <GbrUid mid="900"><txtName>TEST_BORDER</txtName></GbrUid>
        <codeType>OTHER</codeType>
        <Gbv><codeType>GRC</codeType><geoLat>480000.00N</geoLat><geoLong>0070000.00E</geoLong><codeDatum>WGE</codeDatum></Gbv>
        <Gbv><codeType>GRC</codeType><geoLat>481500.00N</geoLat><geoLong>0073000.00E</geoLong><codeDatum>WGE</codeDatum></Gbv>
        <Gbv><codeType>GRC</codeType><geoLat>480000.00N</geoLat><geoLong>0080000.00E</geoLong><codeDatum>WGE</codeDatum></Gbv>
    </Gbr>`;
    const fnt = `<Avx><GbrUid mid="900"><txtName>TEST_BORDER</txtName></GbrUid><codeType>FNT</codeType>
        <geoLat>480000.00N</geoLat><geoLong>0070000.00E</geoLong><codeDatum>WGE</codeDatum></Avx>`;
    const { geojson, stats } = convert(
        snapshot(fnt + vertex('480000.00N', '0080000.00E') + vertex('473000.00N', '0073000.00E'), border)
    );
    const [ring] = geojson.features[0].geometry.coordinates;
    // the intermediate border vertex has to appear between the two anchors
    assert.ok(ring.some((c) => Math.abs(c[1] - (48 + 15 / 60)) < 1e-6 && Math.abs(c[0] - 7.5) < 1e-6));
    assert.equal(stats.borders.ringsUsingBorders, 1);
});

test('a single vertex is a point feature and yields no airspace', () => {
    const { geojson, stats } = convert(snapshot(vertex('480000.00N', '0070000.00E')));
    assert.equal(geojson.features.length, 0);
    assert.equal(stats.pointOnly, 1);
    assert.equal(stats.failed, 0);
});

test('two vertices enclose an area only when one segment is an arc', () => {
    const arcExtra =
        '<geoLatArc>480000.00N</geoLatArc><geoLongArc>0070000.00E</geoLongArc>' +
        '<valRadiusArc>10</valRadiusArc><uomRadiusArc>NM</uomRadiusArc>';
    const straight = convert(snapshot(vertex('480000.00N', '0070000.00E') + vertex('481000.00N', '0070000.00E')));
    assert.equal(straight.geojson.features.length, 0);
    assert.equal(straight.stats.pointOnly, 1);

    const withArc = convert(
        snapshot(vertex('481000.00N', '0070000.00E', 'CWA', arcExtra) + vertex('475000.00N', '0070000.00E'))
    );
    assert.equal(withArc.geojson.features.length, 1);
    assert.ok(area(withArc.geojson.features[0]) > 0);
});

test('an Adg copies the extent of the referenced airspace', () => {
    const second = `<Ase>
        <AseUid mid="101"><codeType>D</codeType><codeId>TEST2</codeId></AseUid>
        <txtName>TEST2</txtName>
        <codeDistVerUpper>STD</codeDistVerUpper><valDistVerUpper>200</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
        <codeDistVerLower>STD</codeDistVerLower><valDistVerLower>100</valDistVerLower><uomDistVerLower>FL</uomDistVerLower>
      </Ase>
      <Adg>
        <AdgUid mid="300"><AseUid mid="101"><codeType>D</codeType><codeId>TEST2</codeId></AseUid></AdgUid>
        <AseUidSameExtent mid="100"><codeType>D</codeType><codeId>TEST1</codeId></AseUidSameExtent>
      </Adg>`;
    const { geojson, stats } = convert(
        snapshot(
            vertex('480000.00N', '0070000.00E') +
                vertex('480000.00N', '0080000.00E') +
                vertex('473000.00N', '0080000.00E'),
            second
        )
    );
    assert.equal(geojson.features.length, 2);
    assert.equal(stats.sameExtent, 1);
    const [first, copy] = geojson.features;
    assert.deepEqual(copy.geometry, first.geometry);
    // ... but its own vertical limits
    assert.deepEqual(copy.properties.lowerCeiling, { value: 100, unit: 'FL', referenceDatum: 'STD' });
});

test('a ring that touches itself is split into a MultiPolygon', () => {
    // two triangles meeting at 48N/7E
    const { geojson, stats } = convert(
        snapshot(
            vertex('480000.00N', '0070000.00E') +
                vertex('480000.00N', '0071000.00E') +
                vertex('481000.00N', '0071000.00E') +
                vertex('480000.00N', '0070000.00E') +
                vertex('475000.00N', '0065000.00E') +
                vertex('475000.00N', '0070000.00E')
        )
    );
    assert.equal(stats.pinched, 1);
    assert.equal(geojson.features[0].geometry.type, 'MultiPolygon');
    assert.equal(geojson.features[0].geometry.coordinates.length, 2);
});

test('an unknown vertex type is reported rather than guessed', () => {
    const { stats } = convert(
        snapshot(
            vertex('480000.00N', '0070000.00E', 'XYZ') +
                vertex('480000.00N', '0080000.00E') +
                vertex('473000.00N', '0080000.00E')
        )
    );
    assert.equal(stats.failed, 1);
    assert.ok(Object.keys(stats.failures)[0].includes("Unsupported vertex type 'XYZ'"));
});

test('the airspace kind comes from txtLocalType where it is set', () => {
    const ring =
        vertex('480000.00N', '0070000.00E') + vertex('480000.00N', '0080000.00E') + vertex('473000.00N', '0080000.00E');
    const plain = convert(snapshot(ring)).geojson.features[0].properties;
    assert.equal(plain.type, 'DANGER'); // codeType D

    const local = convert(snapshot(ring, '', '<txtLocalType>PJE</txtLocalType>')).geojson.features[0].properties;
    assert.equal(local.type, 'AERIAL_SPORTING_RECREATIONAL');
    assert.equal(local.activity, 'PARACHUTING');
});

/**
 * A service association plus two frequencies for it.
 */
function services() {
    return `<Sae>
        <SaeUid mid="700">
          <SerUid mid="500"><UniUid mid="400"><txtName>LFXX TEST</txtName></UniUid>
            <codeType>TWR</codeType><noSeq>10</noSeq></SerUid>
          <AseUid mid="100"><codeType>D</codeType><codeId>TEST1</codeId></AseUid>
        </SaeUid>
      </Sae>
      <Fqy>
        <FqyUid mid="800">
          <SerUid mid="500"><UniUid mid="400"><txtName>LFXX TEST</txtName></UniUid>
            <codeType>TWR</codeType><noSeq>10</noSeq></SerUid>
          <valFreqTrans>118.105</valFreqTrans>
        </FqyUid>
        <uomFreq>MHZ</uomFreq>
        <Ftt><codeWorkHr>H24</codeWorkHr></Ftt>
        <Cdl><txtCallSign>TEST - TOUR</txtCallSign><codeLang>FR</codeLang></Cdl>
        <Cdl><txtCallSign>TEST - TOWER</txtCallSign><codeLang>EN</codeLang></Cdl>
      </Fqy>
      <Fqy>
        <FqyUid mid="801">
          <SerUid mid="500"><UniUid mid="400"><txtName>LFXX TEST</txtName></UniUid>
            <codeType>TWR</codeType><noSeq>10</noSeq></SerUid>
          <valFreqTrans>121.5</valFreqTrans>
        </FqyUid>
        <uomFreq>MHZ</uomFreq>
        <Ftt><codeWorkHr>HX</codeWorkHr></Ftt>
        <Cdl><txtCallSign>TEST - SECOURS</txtCallSign><codeLang>FR</codeLang></Cdl>
      </Fqy>`;
}

const RING =
    '<Avx><codeType>GRC</codeType><geoLat>480000.00N</geoLat><geoLong>0070000.00E</geoLong><codeDatum>WGE</codeDatum></Avx>' +
    '<Avx><codeType>GRC</codeType><geoLat>480000.00N</geoLat><geoLong>0080000.00E</geoLong><codeDatum>WGE</codeDatum></Avx>' +
    '<Avx><codeType>GRC</codeType><geoLat>473000.00N</geoLat><geoLong>0080000.00E</geoLong><codeDatum>WGE</codeDatum></Avx>';

test('frequencies are joined through the service association', () => {
    const { geojson, stats } = convert(snapshot(RING, services()));
    const { frequencies } = geojson.features[0].properties;

    assert.equal(frequencies.length, 2);
    assert.equal(stats.withFrequency, 1);
    assert.equal(stats.withSeveralFrequencies, 1);
    assert.deepEqual(frequencies[0], {
        type: 'TWR',
        value: 118.105,
        unit: 'MHZ',
        // the English call sign wins where both languages are published
        name: 'TEST - TOWER',
        hours: 'H24',
    });
    // ... and the French one is kept where there is no English
    assert.equal(frequencies[1].name, 'TEST - SECOURS');
});

test('an airspace without a service association carries no frequencies', () => {
    const { geojson, stats } = convert(snapshot(RING));

    assert.equal(geojson.features[0].properties.frequencies, undefined);
    assert.equal(stats.withFrequency, 0);
});
