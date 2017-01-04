/**
 * @module stock-brushes/local-elevation
 */

import { BaseBrush, NodeSelectionStrategy } from '../brush';
import { minmax } from '../util';


class LocalElevation extends BaseBrush {
    constructor(spec, scheme, name, params) {
        super(spec, scheme, name, params);

        this.rampStartColor = params.start ? JSON.parse(params.start) : [0, 0, 0];
        this.rampEndColor = params.end ? JSON.parse(params.end) : [255,255,255];
    };

    serialize() {
        // All parameters are gotten from spec
        return {}
    }

    deserialize(json) {
        // Nothing to do here
    }

    static _statsToZRange(params) {
        const {pointCloudBufferStats} = params;
        const allKeys = Object.keys(pointCloudBufferStats.z).map(i => parseInt(i));
        return minmax(allKeys);
    }

    async prepare(parentNode, childrenNodes, params) {
        // Determine what our Z scaling factors are going to be
        const [s, e] = LocalElevation._statsToZRange(params);

        this.min = s;
        this.max = e;
    }

    stagingAttributes(parentNode, childrenNodes, params) {
        // No staging parameters required
        return {
            min: this.min,
            max: this.max
        };
    }

    nodeSelectionStrategy(params) {
        // Could potentially affect all nodes
        const [s, e] = LocalElevation._statsToZRange(params)
        return {
            strategy: NodeSelectionStrategy.ALL,
            params: [s, e]
        }.ALL;
    }

    bufferNeedsRecolor(params, strategyParams, testNode, stagedAttributes) {
        // If cumulative histogram values have changed since this node was colored, we need to re-color this node
        //
        const {min, max}  = stagedAttributes;
        const [s, e] = strategyParams;

        return (min !== s) || (max !== e);
    }

    async unprepare(params) {
        // Nothing to do here
        this.min = this.max = null;
    }

    colorPoint(color, point) {
        color[0] = point.red;
        color[1] = point.green;
        color[2] = point.blue;
    }

    requiredSchemaFields() {
        return ["Red", "Green", "Blue"];
    }
}