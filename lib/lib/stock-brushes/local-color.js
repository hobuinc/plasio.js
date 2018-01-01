/**
 * @module stock-brushes/local-color
 */

import {BaseBrush, NodeSelectionStrategy, ClampSelector, TransferDirection} from '../brush';


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

    beginTransfer(direction) {
        // doesn't matter which direction we're going, transfer the stuff
        return {
            params: {
                needScale: this.needScale,
                scalef: this.scalef
            },
            transferList: []
        };
    }

    endTransfer(direction, params) {
        // doesn't matter which direction we're going
        this.needScale = params.needScale;
        this.scalef = params.scalef;
    }

    static _is16bit(params) {
        const { pointCloudBufferStats } = params;
        if (pointCloudBufferStats.red) {
            for (let k of pointCloudBufferStats.red.keys()) {
                if (k > 256) return true;
            }
        }

        return false;
    }

    async prepare(params, parentNode, childrenNodes) {
        // Nothing to do here
        this.needScale = LocalColor._is16bit(params);
        console.log("-- -- -- -- ", this.needScale);
        this.scalef = this.needScale ? 1/256.0 : 1;
    }

    stagingAttributes(params, parentNode, childrenNodes) {
        // No staging parameters required
        return { is16bit: LocalColor._is16bit(params) };
    }

    nodeSelectionStrategy(params) {
        // if we discover that the color size has changed, we need to request re-color
        //
        return {
            strategy: NodeSelectionStrategy.ALL,
            params: { is16bit: LocalColor._is16bit(params) }
        };
    }

    bufferNeedsRecolor(params, strategyParams, testNodeStagedAttributes) {
        // Nodes never need re-color since their color is read from source
        return strategyParams.is16bit !== testNodeStagedAttributes.is16bit;
    }

    async unprepare(params) {
        // Nothing to do here
        delete this.needScale;
        delete this.scalef;
    }

    colorPoint(color, point) {
        // guide branch in one direction
        if (this.needScale) {
            color[0] = Math.floor(point.red * this.scalef);
            color[1] = Math.floor(point.green * this.scalef);
            color[2] = Math.floor(point.blue * this.scalef);
        }
        else {
            color[0] = point.red;
            color[1] = point.green;
            color[2] = point.blue;
        }
    }

    requiredSchemaFields() {
        return ["Red", "Green", "Blue"];
    }

    rampConfiguration() {
        return {
            selector: ClampSelector.NONE
        };
    }
}