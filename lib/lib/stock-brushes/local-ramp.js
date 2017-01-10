/**
 * @module stock-brushes/local-ramp
 * Color ramps on schema fields.
 */

import { BaseBrush, NodeSelectionStrategy, ClampSelector } from '../brush';
import { minmax, checkParam, parseColor } from '../util';


/**
 * A map of know fields types that we know how to map to a clamp selector.
 */
const knownFieldSelectors = {
    'z': ClampSelector.Z_RANGE,
    'intensity': ClampSelector.INTENSITY_RANGE
};

/**
 * A ramp brush which supports ramping of elevation (z) and intensity values.
 */
export class LocalRamp extends BaseBrush {
    /**
     * Construct a ramp brush.
     * @param {String} spec The complete spec used to instantiate this brush.
     * @param {String} scheme The schema name, should be <tt>local</tt>.
     * @param {String} name The name for this brush, should be <tt>ramp</tt>.
     * @param {Object} params Parameters to construct this brush, these are passed as query parameters in spec.
     * @param {String} params.field Field to use for color ramp, should be <tt>Z</tt> or <tt>Intensity</tt>.
     * @param {Number} params.step A step size for contour like effect.
     * @param {String} params.start A hexadecimal color string representing the start color, e.g. <tt>#ff0000<tt>.
     * @param {String} params.end A hexadecimal color string representing the end color.
     */
    constructor(spec, scheme, name, params) {
        super(spec, scheme, name, params);

        this.field = checkParam(params, 'field');

        // When the user wants to do Z elevation ramping, they actually want to read our Y coordinate.
        this.step = parseInt(checkParam(params, 'step', '1'));
        if (this.step == 0) this.step = 1;

        this.field = this.field.toLowerCase();
        this.readField = this.field.toLowerCase() == 'z' ? 'y' : this.field;

        this.rampStartColor = parseColor(params.start) || [0, 0, 0];
        this.rampEndColor = parseColor(params.end) || [1, 1, 1];

        // Make sure we have the selector specified
        this.selector = checkParam(knownFieldSelectors, this.field);
    };

    serialize() {
        // All parameters are gotten from spec
        return {}
    }

    deserialize(json) {
        // Nothing to do here
    }

    _statsToFieldRange(params) {
        const {pointCloudBufferStats} = params;
        const allKeys = Object.keys(pointCloudBufferStats[this.field] || {}).map(i => parseInt(i));
        return minmax(allKeys);
    }

    async prepare(params, parentNode, childrenNodes) {
        // Determine what our Z scaling factors are going to be
        const [s, e] = this._statsToFieldRange(params);

        if (s >= e) {
            this.noColor = true
        }
        else {
            this.min = s;
            this.max = e;
            this.scalef = 255 / (this.step * (e - s));
        }
    }

    stagingAttributes(params, parentNode, childrenNodes) {
        // No staging parameters required
        return this.noColor ? {} : { min: this.min, max: this.max };
    }

    nodeSelectionStrategy(params) {
        // We only affect other nodes if the schema attribute we are ramping on
        // is actually valid and available.
        const [s, e] = this._statsToFieldRange(params);
        return (s >= e) ?
            { strategy: NodeSelectionStrategy.NONE } :
            { strategy: NodeSelectionStrategy.ALL, params: [s, e] };
    }

    bufferNeedsRecolor(params, strategyParams, testNodeStagedAttributes) {
        // If cumulative histogram values have changed since this node was colored, we need to re-color this node
        //
        const {min, max}  = testNodeStagedAttributes;
        const [s, e] = strategyParams;

        return (min !== s) || (max !== e);
    }

    async unprepare(params) {
        // Nothing to do here
        delete this.min;
        delete this.max;
        delete this.scalef;
        delete this.noColor;
    }

    colorPoint(color, point) {
        if (this.noColor) {
            color[0] = color[1] = color[2] = 0;
        }
        else {
            const h = Math.floor(this.scalef * (point[this.readField] - this.min)) * this.step;

            color[0] = h;
            color[1] = h;
            color[2] = h;
        }
    }

    requiredSchemaFields() {
        return [this.field];
    }

    rampConfiguration() {
        return {
            selector: this.selector,
            start: this.rampStartColor,
            end: this.rampEndColor
        };
    }
}
