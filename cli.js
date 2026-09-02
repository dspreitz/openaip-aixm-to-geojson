#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { bbox } from '@turf/turf';
import { parseXml } from './src/xml.js';
import { convertAirspaces } from './src/converter.js';
import { validateGeojson } from './src/validate.js';

const { values } = parseArgs({
    options: {
        input: { type: 'string', short: 'f', multiple: true },
        outdir: { type: 'string', short: 'o', default: './var' },
        'geometry-detail': { type: 'string', default: '180' },
        'no-fix': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
    },
});

if (values.input == null) {
    console.error(
        'Usage: node cli.js -f <aixm.xml> [-f <aixm.xml> ...] [-o <outdir>] [--geometry-detail 180] [--no-fix]'
    );
    process.exit(1);
}

const sorted = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);
const line = (label, value) => console.log(`  ${String(label).padEnd(38)}${value}`);
const results = [];

for (const input of values.input) {
    const started = Date.now();
    const name = input.split('/').pop();
    console.log(`\n${'='.repeat(78)}\n${name}\n${'='.repeat(78)}`);

    const xml = fs.readFileSync(input);
    const parsed = parseXml(xml);
    const { geojson, stats } = convertAirspaces(parsed, {
        geometryDetail: Number.parseInt(values['geometry-detail'], 10),
        fixGeometries: values['no-fix'] === false,
    });

    const output = `${values.outdir}/${name.replace(/\.xml$/, '')}.geojson`;
    fs.writeFileSync(output, JSON.stringify(geojson));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`\ninput  ${(xml.length / 1024 / 1024).toFixed(1)} MB   ->   ${output}   (${seconds}s)`);

    console.log(`\nmembers`);
    for (const [member, count] of sorted(stats.members)) line(member, count);

    console.log(`\nairspaces`);
    line('converted', `${stats.converted} / ${stats.converted + stats.failed}`);
    line('failed', stats.failed);
    line('aggregated (BASE + UNION)', stats.aggregated);
    line('vertical limits from contributors', stats.limitsFromContributors);
    line('emitted as MultiPolygon', stats.multiPolygons);
    line('partial (contributor not in file)', stats.partialAggregations.length);

    console.log(`\nring parts`);
    for (const [kind, count] of sorted(stats.parts)) line(kind, count);

    console.log(`\ngeo borders`);
    line('GeoBorder features in file', stats.borders.available);
    line('rings using a border reference', stats.borders.ringsUsingBorders);
    for (const [border, count] of sorted(stats.borders.used)) line(`  ${border}`, count);

    const validation = validateGeojson(geojson);
    console.log(`\nschema`);
    line('output conforms to schema', validation.valid ? 'yes' : `NO (${validation.errors.length} errors)`);
    for (const error of validation.errors.slice(0, 5)) line(`  ${error.instancePath}`, error.message);

    console.log(`\ngeometry quality`);
    line('self-intersecting rings', stats.selfIntersecting);
    line('repaired', stats.repaired);
    line('max part join gap (m)', stats.joinGaps.max.toFixed(1));
    line('  worst airspace', stats.joinGaps.worst ?? '-');
    line('rings with join gap > 10 m', stats.joinGaps.over10m);
    line('rings with join gap > 100 m', stats.joinGaps.over100m);
    if (geojson.features.length > 0) {
        line(
            'bbox [W S E N]',
            bbox(geojson)
                .map((v) => v.toFixed(3))
                .join(', ')
        );
    }

    if (Object.keys(stats.unmapped).length > 0) {
        console.log(`\nunmapped values`);
        for (const [value, count] of sorted(stats.unmapped)) line(value, count);
    }

    if (stats.failed > 0) {
        console.log(`\nfailures`);
        for (const [reason, count] of sorted(stats.failures)) line(reason, count);
        for (const sample of stats.failureSamples) console.log(`    ${sample}`);
    }

    if (stats.partialAggregations.length > 0 && values.quiet === false) {
        console.log(`\npartial aggregations`);
        for (const entry of stats.partialAggregations) console.log(`    ${entry}`);
    }

    results.push({ name, geojson, output });
}

export {};
