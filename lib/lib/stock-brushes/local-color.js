/**
 * @module stock-brushes/local-color
 */

import { BaseBrush, NodeSelectionStrategy } from '../brush';


export class LocalColor extends BaseBrush {
    constructor(spec, scheme, name, params) {
        super(spec, scheme, name, params);
    };

    serialize() {
        // No params needed
        return {}
    }

    deserialize(json) {
        // Nothing to do here
    }

    async prepare(parentNode, childrenNodes, params) {
        // Nothing to do here
    }

    stagingAttributes(parentNode, childrenNodes, params) {
        // No staging parameters required
        return null;
    }

    nodeSelectionStrategy() {
        // The source coloring is read directly from the source, so we don't really
        // affect any other nodes
        return {
            strategy: NodeSelectionStrategy.NONE,
            params: {}
        };
    }

    bufferNeedsRecolor(params, strategyParams, testNode, stagedAttributes) {
        // Nodes never need re-color since their color is read from source
        return false;
    }

    async unprepare(params) {
        // Nothing to do here
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