/**
 * @module stock-brushes/local-field-color
 * Color by any field, each field value is assigned a semi-random color using the HSL color model.
 */

import { BaseBrush, NodeSelectionStrategy, ClampSelector } from '../brush';
import { hslToRgb, checkParam } from '../util';

/**
 * A local field color brush, assigns a semi-random hue value to each point.
 */
export class LocalFieldColor extends BaseBrush {
    /**
     * Construct a local field coloring brush.
     * @param {String} spec The complete spec used to instantiate this brush.
     * @param {String} scheme The schema name, should be <tt>local</tt>.
     * @param {String} name The name for this brush, should be <tt>field-color</tt>.
     * @param {Object} params Parameters to construct this brush, these are passed as query parameters in spec.
     * @param {String} params.field Field to use for selecting the color's hue.
     * @param {Number} [params.saturation] The saturation value to use, 0 -> 1.  Defaults to 0.5.
     * @param {String} [params.lightness] The lightness value to use, 0 -> 1. Defaults to 0.5.
     * @param {Number} [params.scale] Each field value is scaled with this value before determining its hue.
     * Defaults to 1000, for fields which don't have a lot or range, scaling helps provide more varied color assignments.
     */
    constructor(spec, scheme, name, params) {
        super(spec, scheme, name, params);

        this.field = checkParam(params, 'field');

        // When the user wants to do Z coloring , they actually want to read our Y coordinate.
        this.saturation = parseFloat(checkParam(params, 'saturation', '0.5'));
        this.lightness = parseFloat(checkParam(params, 'lightness', '0.5'));
        this.scale = parseFloat(checkParam(params, 'scale', 1000));

        this.field = this.field.toLowerCase();
        this.readField = this.field == 'z' ? 'y' : (this.field == 'y' ? 'z' : this.field);
    };

    serialize() {
        // All parameters are gotten from spec
        return {}
    }

    deserialize(json) {
        // Nothing to do here
    }

    async prepare(params, parentNode, childrenNodes) {
    }

    stagingAttributes(params, parentNode, childrenNodes) {
        return {};
    }

    nodeSelectionStrategy(params) {
        return { strategy: NodeSelectionStrategy.NONE };
    }

    bufferNeedsRecolor(params, strategyParams, testNodeStagedAttributes) {
        return false;
    }

    async unprepare(params) {
    }

    colorPoint(color, point) {
        const v = point[this.readField];
        hslToRgb(Math.floor((Math.abs(v) * this.scale) % 360) / 360, this.saturation, this.lightness, color);
    }

    requiredSchemaFields() {
        return [this.field];
    }

    rampConfiguration() {
        return {
            selector: ClampSelector.NONE
        }
    }
}
