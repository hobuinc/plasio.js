// geotransform.js
// Abstract out transformation details

import *  as _ from "lodash";

export class GeoTransform {
    /**
     * Construct a GeoTransform instance which can be used to query several things about our world.
     * This class may be used to transform coordinate spaces between geo, tree and render.  Appropriate
     * scale and offset will be applied so that geo coordinates are always real geo coordinates, tree coordinates
     * are offseted at the origin and no scale is applied and the render transform is scaled and offsetted correctly.
     * @param {Number[]} fullGeoBounds Actual geo bounds, not scaled or offsetted.
     * @param {Number} scale The scale to consider when performing transforms
     * @param {Number} offset The offset to consider when performing transform
     */
    constructor(fullGeoBounds, scale, offset) {
        if (!_.isArray(fullGeoBounds) && _.size(fullGeoBounds) != 6)
            throw new Error('fullGeoBounds need to be an array with 6 items');

        if (!_.isArray(scale) && _.size(scale) != 3)
            throw new Error('scale need to be an array with 3 items');

        if (!_.isArray(offset) && _.size(offset) != 3)
            throw new Error('offset need to be an array with 3 items');

        // Actual geo bounds, not scaled and not offsetted
        this.fullGeoBounds = fullGeoBounds;

        // The scale this data set is dealing with
        this.scale = scale;

        // The offset this data set is dealing with
        this.offset = offset;
    }

    /**
     * Transform a 3-vector or a 6-vector (bounds) from one space to another.
     * @param {Number[]} arg A 3-vector or a 6-vector to transform.
     * @param {String} sourceTransform Can be any of 'geo', 'render' or 'tree' and specifies what coordinate space the arg is in.
     * @param {String} destinationTransform Can be any of 'geo', 'render' or 'tree' and specifies what space to convert arg to.
     * @returns {Number[]} A converted 3-vector or a 6-vector
     */
    transform(arg, sourceTransform, destinationTransform) {
        const KNOWN_TRANSFORMS = ["geo", "tree", "render"];

        if (!KNOWN_TRANSFORMS.includes(sourceTransform))
            throw new Error('sourceTransform is not recognized, specified: ' + sourceTransform + ', accepted: ' + KNOWN_TRANSFORMS.join(', '));

        if (!KNOWN_TRANSFORMS.includes(destinationTransform))
            throw new Error('destinationTransform is not recognized, specified: ' + destinationTransform + ', accepted: ' + KNOWN_TRANSFORMS.join(', '))

        if (!_.isArray(arg) && (_.size(arg) != 3 || _.size(arg) != 6))
            throw new Error('arg needs to be an array of size 3 or 6, specified: ' + arg.toString());

        const fullGeoBounds = this.fullGeoBounds;
        const scale = this.scale;
        const offset = this.offset;

        // first transform all to our normalized coordinate space
        let normalized = null;
        if (sourceTransform === 'tree') normalized = arg.slice(0);
        else if (sourceTransform === 'geo') normalized = arg.map((v, i) => (v - offset[i % 3]) / scale[i % 3]);
        // render
        else {
            const s = [scale[0], scale[2], scale[1]];
            let p = arg.map((v, i) => v / s[i % 3]);
            normalized = (p.length === 3) ? [-p[0], p[2], p[1]] : [-p[0], p[2], p[1], -p[3], p[5], p[4]];
        }

        // we now have normalized coordinates, convert them to destination
        let destination = null;
        if (destinationTransform === 'tree') destination = normalized.slice(0);
        else if (destinationTransform === 'geo') destination = normalized.map((v, i) => (v * scale[i % 3]) + offset [i % 3]);
        else {
            let p = normalized;
            p = (p.length === 3) ? [-p[0], p[2], p[1]] : [-p[0], p[2], p[1], -p[3], p[5], p[4]];
            console.log('p', p);
            const s = [scale[0], scale[2], scale[1]];
            destination = p.map((v, i) => v * s[i % 3]);
        }

        return destination;
    }

    /**
     * Get the range of the specified coordinate space.
     * @param {Number[]} inTransform The coordinate space in which to compute the range.
     * @returns {Number[]} A 3-vector with range of each coordinate axis in inTransform coordinate space.
     */
    coordinateSpaceRange(inTransform) {
        const bounds = this.transform(this.fullGeoBounds, 'geo', inTransform);

        return [
            bounds[3] - bounds[0],
            bounds[4] - bounds[1],
            bounds[5] - bounds[2]
        ];
    }

    /**
     * Determine center in specified coordinate space.
     * @param {String} inTransform The transform to compute center in.
     * @return {Number[]} The computed center in specified coordinate space.
     */
    coordinateSpaceCenter(inTransform) {
        const bounds = this.transform(this.fullGeoBounds, 'geo', inTransform);

        return [
            bounds[0] + (bounds[3] - bounds[0]) * 0.5,
            bounds[1] + (bounds[4] - bounds[1]) * 0.5,
            bounds[2] + (bounds[5] - bounds[2]) * 0.5
        ];
    }

    /**
     * Get the bounds in the specified coordinate space
     * @param {String} inTransform The transform to compute bounds in.
     * @return {Number[]} The computed 6-vector bounds in given coordinate space
     */
    coordinateSpaceBounds(inTransform) {
        const bounds = this.transform(this.fullGeoBounds, 'geo', inTransform);
        return bounds;
    }

}