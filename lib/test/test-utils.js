/**
 * @module test-utils
 */

import { GeoTransform } from "../lib/geotransform";

function computeStats(buffer, totalPoints, schema) {
    const pointSize = schema.length;

    let offset = 0;
    const stats = {};

    for (let i = 0 ; i < totalPoints ; i ++) {
        for (let j = 0 ; j < pointSize ; j ++) {
            const val = buffer[offset + j];
            const fieldKey = schema[j].name.toLowerCase();
            const fieldHistogram = stats[fieldKey] || {};
            const bin = (Math.floor(val / 10) * 10).toString();
            let binVal = fieldHistogram[bin] || 0;
            binVal ++;
            fieldHistogram[bin] = binVal;
            stats[fieldKey] = fieldHistogram;
        }

        offset += pointSize;
    }

    return stats;
}

export function dummyDownloadedData(numPoints, fieldSpecs) {
    const numFields = 3 + fieldSpecs.length;
    const buffer = new Float32Array(numFields * numPoints);

    const schema = [
        {name: 'X', type: 'signed', size: 4},
        {name: 'Y', type: 'signed', size: 4},
        {name: 'Z', type: 'signed', size: 4},
    ];

    fieldSpecs.forEach(({name}) => {
        schema.push({name: name, type: 'signed', size: 2})
    });

    let offset = 0;
    for (let i = 0 ; i < numPoints ; i ++) {
        buffer[offset + 0] = Math.random() * 100 - 50;
        buffer[offset + 1] = Math.random() * 100 - 50;
        buffer[offset + 2] = Math.random() * 100 - 50;

        fieldSpecs.forEach(({max}, i) => {
            buffer[offset + 3 + i] = Math.random() * max;
        });

        offset += numFields;
    }

    const geoTransform = new GeoTransform([-50, -50, -50, 50, 50, 50], [1, 1, 1], [0, 0, 0]);
    const renderSpaceBounds = geoTransform.transform([-50, -50, -50, 50, 50, 50], 'geo', 'render');
    const stats = computeStats(buffer, numPoints, schema);

    return {
        data: buffer,
        schema,
        geoTransform, renderSpaceBounds,
        totalPoints: numPoints,
        bufferStats: stats, pointCloudBufferStats: stats
    };
}