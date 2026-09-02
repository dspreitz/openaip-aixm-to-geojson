import assert from 'node:assert/strict';
import test from 'node:test';
import { convertAirspaces } from '../src/converter.js';
import { distanceMeters } from '../src/geodesic.js';
import { createVerticalLimit } from '../src/units.js';
import { child, parseXml } from '../src/xml.js';

const NS =
    'xmlns:message="http://www.aixm.aero/schema/5.1.1/message" xmlns:aixm="http://www.aixm.aero/schema/5.1.1" ' +
    'xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

/**
 * Wraps ring curve members into a complete, minimal AIXM message.
 */
function message(curveMembers, extraMembers = '') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<message:AIXMBasicMessage ${NS}>
  <message:hasMember>
    <aixm:Airspace>
      <gml:identifier codeSpace="urn:uuid:">11111111-2222-3333-4444-555555555555</gml:identifier>
      <aixm:timeSlice>
        <aixm:AirspaceTimeSlice>
          <aixm:type>D</aixm:type>
          <aixm:name>TEST</aixm:name>
          <aixm:designator>TEST</aixm:designator>
          <aixm:geometryComponent>
            <aixm:AirspaceGeometryComponent>
              <aixm:theAirspaceVolume>
                <aixm:AirspaceVolume>
                  <aixm:upperLimit uom="FL">100</aixm:upperLimit>
                  <aixm:upperLimitReference>STD</aixm:upperLimitReference>
                  <aixm:lowerLimit uom="FT">1500</aixm:lowerLimit>
                  <aixm:lowerLimitReference>SFC</aixm:lowerLimitReference>
                  <aixm:horizontalProjection>
                    <aixm:Surface srsName="urn:ogc:def:crs:EPSG::4326">
                      <gml:patches><gml:PolygonPatch><gml:exterior><gml:Ring>
                        ${curveMembers}
                      </gml:Ring></gml:exterior></gml:PolygonPatch></gml:patches>
                    </aixm:Surface>
                  </aixm:horizontalProjection>
                </aixm:AirspaceVolume>
              </aixm:theAirspaceVolume>
            </aixm:AirspaceGeometryComponent>
          </aixm:geometryComponent>
        </aixm:AirspaceTimeSlice>
      </aixm:timeSlice>
    </aixm:Airspace>
  </message:hasMember>
  ${extraMembers}
</message:AIXMBasicMessage>`;
}

const inlineCurve = (positions) =>
    `<gml:curveMember><gml:Curve srsName="urn:ogc:def:crs:EPSG::4326"><gml:segments>
        <gml:GeodesicString>${positions.map((p) => `<gml:pos>${p}</gml:pos>`).join('')}</gml:GeodesicString>
     </gml:segments></gml:Curve></gml:curveMember>`;

const convert = (xml, config) => convertAirspaces(parseXml(xml), config);
const ringOf = (result) => result.geojson.features[0].geometry.coordinates[0];

test('positions are read as latitude/longitude for EPSG:4326', () => {
    const { geojson } = convert(message(inlineCurve(['52.0 13.0', '52.0 13.1', '52.1 13.1', '52.0 13.0'])));
    const [longitude, latitude] = geojson.features[0].geometry.coordinates[0][0];

    assert.equal(longitude, 13);
    assert.equal(latitude, 52);
});

test('a circle by centre point has the requested geodesic radius', () => {
    const circle = `<gml:curveMember><gml:Curve srsName="urn:ogc:def:crs:EPSG::4326"><gml:segments>
        <gml:CircleByCenterPoint numArc="1"><gml:pos>52.0 13.0</gml:pos>
        <gml:radius uom="[nmi_i]">5</gml:radius></gml:CircleByCenterPoint>
     </gml:segments></gml:Curve></gml:curveMember>`;
    const ring = ringOf(convert(message(circle)));

    for (const position of ring) {
        assert.ok(Math.abs(distanceMeters([13, 52], position) - 5 * 1852) < 0.5);
    }
});

/*
 AIXM Coding Guidelines, "Arc by Centre Point": with a latitude-first CRS the arc is drawn
 clockwise when startAngle < endAngle and counter-clockwise when startAngle > endAngle.
 Both arcs below run between the same two points, so only the direction distinguishes them.
*/
function arcRing(startAngle, endAngle) {
    const arc = `<gml:ArcByCenterPoint numArc="1"><gml:pos>52.0 13.0</gml:pos>
        <gml:radius uom="[nmi_i]">5</gml:radius>
        <gml:startAngle uom="deg">${startAngle}</gml:startAngle>
        <gml:endAngle uom="deg">${endAngle}</gml:endAngle></gml:ArcByCenterPoint>`;
    const north = '52.08331 13.0';
    const south = '51.91669 13.0';

    return message(
        `<gml:curveMember><gml:Curve srsName="urn:ogc:def:crs:EPSG::4326"><gml:segments>
            <gml:GeodesicString><gml:pos>${south}</gml:pos><gml:pos>${north}</gml:pos></gml:GeodesicString>
            ${arc}
         </gml:segments></gml:Curve></gml:curveMember>`
    );
}

test('startAngle < endAngle sweeps the arc clockwise (through east)', () => {
    const ring = ringOf(convert(arcRing(0, 180)));
    const midpoint = ring[Math.floor(ring.length / 2)];

    assert.ok(midpoint[0] > 13, `expected the arc to bulge east, got longitude ${midpoint[0]}`);
});

test('startAngle > endAngle sweeps the arc counter-clockwise (through west)', () => {
    const ring = ringOf(convert(arcRing(0, -180)));
    const midpoint = ring[Math.floor(ring.length / 2)];

    assert.ok(midpoint[0] < 13, `expected the arc to bulge west, got longitude ${midpoint[0]}`);
});

test('an arc joins its neighbouring vertices exactly', () => {
    // radius and angles deliberately disagree with the neighbours, as they do in the DFS data
    const ring = ringOf(convert(arcRing(0.4, 179.6)));

    assert.ok(distanceMeters(ring[0], ring.at(-1)) < 0.001);
    // ring[0] -> ring[1] is the straight chord; everything after it is the arc, which must
    // step smoothly and meet the chord's ends without a gap
    const arcGaps = ring.slice(2).map((position, index) => distanceMeters(ring[index + 1], position));
    assert.ok(Math.max(...arcGaps) < 400, `unexpected jump of ${Math.max(...arcGaps).toFixed(1)} m in the arc`);
});

test('a referenced GeoBorder is clipped between the neighbouring ring vertices', () => {
    const borderPositions = ['52.0 13.0', '52.0 13.1', '52.0 13.2', '52.0 13.3', '52.0 13.4'];
    const border = `<message:hasMember><aixm:GeoBorder>
        <gml:identifier codeSpace="urn:uuid:">99999999-8888-7777-6666-555555555555</gml:identifier>
        <aixm:timeSlice><aixm:GeoBorderTimeSlice>
          <aixm:name>TESTBORDER</aixm:name><aixm:type>STATE</aixm:type>
          <aixm:border><aixm:Curve srsName="urn:ogc:def:crs:EPSG::4326"><gml:segments>
            <gml:GeodesicString>${borderPositions.map((p) => `<gml:pos>${p}</gml:pos>`).join('')}</gml:GeodesicString>
          </gml:segments></aixm:Curve></aixm:border>
        </aixm:GeoBorderTimeSlice></aixm:timeSlice></aixm:GeoBorder></message:hasMember>`;

    // ring: from (52.0,13.1) south around and back to (52.0,13.3), then along the border
    const xml = message(
        `${inlineCurve(['52.0 13.3', '51.9 13.3', '51.9 13.1', '52.0 13.1'])}
         <gml:curveMember xlink:href="urn:uuid:99999999-8888-7777-6666-555555555555"/>`,
        border
    );
    const { geojson, stats } = convert(xml);
    const ring = geojson.features[0].geometry.coordinates[0];

    assert.equal(stats.borders.ringsUsingBorders, 1);
    // only the intermediate border vertex 13.2 lies between the two anchors
    // (the closing vertex repeats the ring's first position and is dropped here)
    const onBorder = ring
        .slice(0, -1)
        .filter((position) => Math.abs(position[1] - 52) < 1e-9)
        .map((position) => position[0]);
    assert.deepEqual(
        onBorder.sort((a, b) => a - b),
        [13.1, 13.2, 13.3]
    );
});

test('vertical limits are normalised to openAIP units and datums', () => {
    const limitNode = (uom, value) =>
        child(parseXml(`<a><aixm:x uom="${uom}" ${NS}>${value}</aixm:x></a>`)[0], 'aixm:x');
    const reference = (value) => child(parseXml(`<a><aixm:r ${NS}>${value}</aixm:r></a>`)[0], 'aixm:r');

    assert.deepEqual(createVerticalLimit(limitNode('FL', '100'), reference('STD')), {
        value: 100,
        unit: 'FL',
        referenceDatum: 'STD',
    });
    assert.deepEqual(createVerticalLimit(limitNode('FT', '1500'), reference('SFC')), {
        value: 1500,
        unit: 'FT',
        referenceDatum: 'GND',
    });
    // metres are converted to feet
    assert.deepEqual(createVerticalLimit(limitNode('M', '1000'), reference('MSL')), {
        value: 3281,
        unit: 'FT',
        referenceDatum: 'MSL',
    });
});

test('the AIXM UUID is carried through as the feature id', () => {
    const { geojson } = convert(message(inlineCurve(['52.0 13.0', '52.0 13.1', '52.1 13.1', '52.0 13.0'])));

    assert.equal(geojson.features[0].id, '11111111-2222-3333-4444-555555555555');
});
