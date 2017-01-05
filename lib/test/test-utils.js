/**
 * @module test-utils
 */

import { GeoTransform } from "../lib/geotransform";
import { BaseBrush } from "../lib/brush";

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


export class FunkyColor extends BaseBrush {
    constructor(spec, scheme, name, params) {
        super(spec, scheme, name, params);
        this.events = [];
    };

    serialize() {
        // All parameters are gotten from spec
        return {
            testfield1: "hi",
            testfield2: "by"
        };
    }

    deserialize(json) {
        // Nothing to do here
        this.deserialized = json;
    }

    async prepare(parentNode, childrenNodes, params) {
        // Determine what our Z scaling factors are going to be
        this.events.push(["prepare", parentNode, childrenNodes, params]);
    }

    stagingAttributes(parentNode, childrenNodes, params) {
        // No staging parameters required
        this.events.push(["stagingAttributes", parentNode, childrenNodes, params]);
        return {
            so: "wow",
            many: "yes"
        };
    }

    nodeSelectionStrategy(params) {
        // Could potentially affect all nodes
        return {
            strategy: NodeSelectionStrategy.ALL,
            params: {
                yay: "wow"
            }
        };
    }

    bufferNeedsRecolor(params, strategyParams, testNode) {
        this.events.push(["bufferNeedsRecolor", params, strategyParams, testNode])
        // If cumulative histogram values have changed since this node was colored, we need to re-color this node
        //
        return true;
    }

    async unprepare(params) {
        this.events.push(["unprepare", params]);
    }

    colorPoint(color, point) {
        this.events.push(["colorPoint", point]);
        color[0] = 1;
        color[1] = 2;
        color[2] = 3;
    }

    requiredSchemaFields() {
        this.events.push(["requiredSchemaFields"]);
        return ["Z"];
    }
}

