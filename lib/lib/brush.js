/**
 * Created by verma on 12/30/16.
 */

/**
 * A coloring strategy may affect one or more nodes in the point cloud tree. E.g. painting a point buffer by the source
 * color may not affect other nodes, since that information is pretty much constant.  However, painting a buffer by elevation
 * may be affected when we discover that the stats used to compute colors for some of nodes are now outdated since we now have
 * much finer stats, lets say a buffer was colored considering Y range as -100 to 100, but now since we downloaded more data
 * we see that the stats are actually -100 to 110.  Since the shaders will now see scaling factors as -100 to 110, the
 * coloring we performed considering -100 to 100 range are incorrect and would need to be recolored.
 *
 * This situation is even more evident with remote imagery.  When viewing buffers from higher (closer to the root) tree nodes, we download lower
 * resolution imagery, but as we zoom into certain areas of the point cloud we download imagery with higher resolution with
 * very obvious color differences from the lower resolution ones.  This causes points with very different colors being placed
 * right next to each other when rendering.  What we really need to do is propagate any new imagery downloads up the tree and have those
 * tree nodes recolored with any new imagery.  Under this strategy we affect nodes that are current buffer's ancesotors.
 *
 * Node selection strategy when determine which nodes are affected by a painting of a point buffer.
 * @property {number} NONE Doesn't affect any other nodes.
 * @property {number} ALL  May potentially affect all loaded nodes.
 * @property {number} ANCESTORS May potentially affect all ancestor nodes.
 */
export const NodeSelectionStrategy = Object.freeze({
    NONE: 0,
    ALL: 1,
    ANCESTORS: 2
});

/**
 * Point shader programs provide certain ranges picked from the current point cloud stats to clamp certain coloring
 * attributes against.  E.g. when coloring points based on elevation, the shader provides a clamping range that represents
 * the current min and max Z values.  When computing final color these ranges are used to show the correct color based on
 * the color computed for the point (from the brush) and the clamping set through the UI.
 *
 * If you are creating a brush which needs to use color ramps, then the value returned here represents the color scaling factor
 * you're using.
 *
 * @property {number} NONE No color clamping is required, use the passed down color as is.
 * @property {number} COLOR_RANGE Clamp to color range bounds, 0 to 1 on the GPU.
 * @property {number} Z_RANGE Use the current Z range as min and max clamping factors.
 * @property {number} INTENSITY_RANGE Use the current Intensity range as min and max clamping factors.
 */
export const ClampSelector = Object.freeze({
    NONE: 0,
    COLOR_RANGE: 1,
    Z_RANGE: 2,
    INTENSITY_RANGE: 3
});


/**
 * @typedef {Object} NodeSelectionParams
 * @property {NodeSelectionStrategy} strategy A {@linkcode NodeSelectionStrategy} to use to select candidate nodes.
 * @property {Object} params An arbitrary object to avoid per node computations (pre-calculate values and return as this).
 */

/**
 * @typedef {Object.<string, Number>} BufferStatsHistogram
 * Buffer stats histogram, the keys of this map are always numbers represented as strings and the values are the frequency values.
 * @example
 * {
 *     "100": 10,
 *     "110": 8,
 *     "120": 9
 *     // ...
  * }
 */

/**
 * @typedef {Object.<string, BufferStatsHistogram>} BufferStats
 * The keys of this object are lower-case names of schema field names e.g. <tt>red</tt>, <tt>z</tt> etc.
 * @example
 * {
 *     "z": {
 *         "100": 10,
 *         "110": 8,
 *         "120": 9
 *         // ...
 *     }
 *     "red": {
 *         // ...
 *     }
 * }
 */


/**
 * @typedef {Object} BufferParams
 * Per-buffer parameters as passed to several brush functions.
 * @property {GeoTransform} geoTransform The geo transform instance for the loaded resource.
 * @property {Number[]} renderSpaceBounds The render space bounds of the particular point buffer being prepped for painting.
 * @property {BufferStats} bufferStats The collected stats for the buffer that needs painting.
 * @property {BufferStats} pointCloudBufferStats The cumulative stats of the point cloud, after the buffer stats have been merged in.
 * @property {String} treePath The node's tree path.
 * @property {Object.<String, Object>} [lastStagedAttributes] If this node is being being re-colored this holds the last staged attributes for this brush.
 */


/**
 * Base class for all brush types, all methods defined in this class need to be implemented by new brush types.
 * Brushes are used to color point clouds.  Brushes are responsible for providing certain methods to
 * allow per point coloring, have a prep and un-prep phase, as well as a way to query under what circumstances
 * a re-color of already colored nodes is needed.  When a re-color is needed a brush also provides for a node selector strategy,
 * some brushes affect all loaded nodes, some only affect the nodes in the hierarchical tree structure.
 */
export class BaseBrush {
    /**
     * Create a brush instance with the given spec URL.
     * @param brushSpec {String} A URL like string that specifies brush attributes.
     * @param brushScheme {String} The scheme this brush belongs to, e.g. <tt>local</tt>.
     * @param brushName {String} The name for the brush.
     * @param params {Object} An arbitrary object specifying brush specific parameters.
     */
    constructor(brushSpec, brushScheme, brushName, params) {
        this.brushScheme = brushScheme;

        this.brushName = brushName;
        this.brushSpec = brushSpec;
        this.brushParams = params;
    }

    /**
     * This method is called on your brush when a node is being serialized to be added to the renderer.  This function
     * should return all parameters needed for the brush to be recreated when the point buffer is to be painted. Please note,
     * only parameters which cannot be recovered from the spec string need to be included here.  The brush is recreated using
     * the brush's constructor and then the {@link BaseBrush#deserialize} is called on it.
     * @return {object} An arbitrary object with enough information to de-serialize the brush.  All attributes must be
     * serializable to JSON.
     */
    serialize() {
        throw new Error('Not implemented');
    }

    /**
     * Takes the params are returned by the serialize call and constructs the brush instance.
     * @param params {object} A serialized object as returned by the {@link BaseBrush#serialize} call.
     * @return {BaseBrush} A de-serialized brush.
     */
    deserialize(params) {
        throw new Error('Not implemented');
    }

    /**
     * Prepares the brush for point cloud coloring, do all async tasks of loading remote sources in this function call. This calls
     * provides information about the node's placement in the point cache as well by specifying the parent and children nodes this
     * node will receive when placed in the cache.
     *
     * @param {BufferParams} params Per buffer parameters for current buffer about to be colored.
     * @param {object} parentNode The parent node for placement in point buffer cache, the passed object is considered opaque and is similar to what
     * {@link BaseBrush#stagingAttributes} returns.
     * @param {object[]} childrenNodes All children nodes under this node in point buffer cache, an array of opaque children nodes as returned by
     * the {@link BaseBrush#stagingAttributes} function.
     */
    async prepare(params, parentNode, childrenNodes) {
        throw new Error('Not implemented');
    }


    /**
     * This method is called right before the brush is un-prepared and after its done coloring the current point buffer. Anything
     * returned from this call is stored along with the point buffer in the point buffer cache.  These parameters are later
     * passed to the {@link BaseBrush#bufferNeedsRecolor} method to determine if any of the already loaded buffers need to be recolored
     * because of changes seen in the current buffer.
     *
     * @param {BufferParams} params Per buffer parameters needed to color nodes.
     * @param {object} parentNode The node under which the current point buffer will be staged in the point buffer cache.  The attributes
     * under this object will be the same as what this function returns.
     * @param {object[]} childrenNodes Children nodes, if any, that will be placed as children of this node in point buffer cache hierarchy.
     * @return {object} An arbitrary object stored in the point buffer cache.
     */
    stagingAttributes(params, parentNode, childrenNodes) {
        throw new Error('Not implemented');
    }

    /**
     * The node selection strategy used to collect nodes to determine which nodes may need a re-color.
     * @param {BufferParams} params Per buffer parameters of the current node for which node coloring impact needs to be determined.
     * @return {NodeSelectionParams} Parameters indicating how to determine nodes for filtering and pre-computed parameters.
     */
    nodeSelectionStrategy(params) {
        throw new Error('Not implemented');
    }

    /**
     * Determines if the passed node needs to be recolored.  The set of nodes for which this function is called are determined
     * by {@link BaseBrush#nodeSelectionStrategy} function.  Every node for which this function returns true is passed through
     * the same painting pipeline as new buffers.
     *
     * @param {BufferParams} params Per buffer parameters, same as the parameters passed to {@link BaseBrush#prepare}.  This params are for the node for which
     * the impact on already loaded node is being determined.
     * @param {object} strategyParams The params returned while determining node selection selection from {@linkcode BaseBrush#nodeSelectionStrategy}.
     * @param {object} testNodeStagedAttributes The last staged attributes for the node being considered for re-coloring requirement.
     */
    bufferNeedsRecolor(params, strategyParams, testNodeStagedAttributes) {
        throw new Error('Not implemented');
    }

    /**
     * Unprepare the prepare phase for a point buffer, any resources allocated in {@link BaseBrush#prepare} call may be released here.
     * @param {BufferParams} params Per buffer parameters, same as the parameters passed to {@link BaseBrush#prepare}.
     */
    async unprepare(params) {
        throw new Error('Not implemented');
    }

    /**
     * Color a single point
     * @param {Number[]} color A 3 element array to which the color needs to be written.
     * @param {object} point Arbitrary object which represents the point being colored.  Each field is available under
     * its respective schema field name. e.g. point.x and point.intensity.
     */
    colorPoint(color, point) {
        throw new Error('Not implemented');
    }

    /**
     * Return an array of schema fields required for the color source to work correctly.  This brush is only invoked
     * for coloring when all required fields are available in schema.
     * @return {String[]} An array of schema field names.
     */
    requiredSchemaFields() {
        throw new Error('Not implemented');
    }

    /**
     * Return the required clamping range factors to scale this brush's computed color values. The returned range is used to
     * compute the on-the-fly color ramp values on the GPU.  The returned factor here is usually the same as what is used to
     * compute point color based on this brush.
     *
     * @returns {{selector: ClampSelector, start: Number[], end: Number[]}} The clamp selector to use for this brush.
     */
    rampConfiguration() {
        throw new Error('Not implemented');
    }
}
