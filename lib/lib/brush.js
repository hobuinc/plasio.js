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
 * Base class for all brush types, all methods defined in this class need to be implemented by new brush types.
 * Brushes are used to color point clouds.  Brushes are responsible for providing certain methods to
 * allow per point coloring, have a prep and unprep phase, as well as a way to query under what circumstances
 * a re-color of already colored nodes is needed.  When a re-color is needed a brush also provides for a node selector strategy,
 * some brushes affect all loaded nodes, some only affect the nodes in the hierarchical tree structure.
 */
export class BaseBrush {
    /**
     * Create a brush instance with the given spec URL.
     * @param brushName {String} A friendly name for the brush.
     * @param brushSpec {String} A URL like string that specifies brush attributes.
     */
    constructor(brushName, brushSpec) {
        this.brushName = brushName;
        this.brushSpec = brushSpec;

        this.brushParams = this._parseBrushParams(this.brushSpec);
    }


    /**
     * Parse brush parameters specific to the brush being implemented.  The return value is considered opaque
     * and only makes sense in scope of the brush being implemented.
     *
     * @param brushSpec
     * @return {object} An opaque object representing brush properties.
     * @private
     */
    _parseBrushParams(brushSpec) {
        throw new Error('Not implemented');
    }


    /**
     * This method is called on your brush when a node is being serialized to be added to the renderer.  This function
     * should return all parameters needed for the brush to be recreated when the point buffer is to be painted.
     * @return {object} An arbitrary object with enough information to de-serialize the brush.  All attributes must be
     * serializable to JSON.
     */
    serialize() {
        return {
            bn: this.brushName,
            bs: this.brushSpec,
        };
    }

    /**
     * Takes the params are returned by the serialize call and constructs the brush instance.
     * @param params {object} A serialized object as returned by the {@link BaseBrush#serialize} call.
     * @return {BaseBrush} A deserialized brush.
     */
    static deserialize(params) {
        this.brushName = util.checkParam(params, 'bn');
        this.brushSpec = util.checkParam(params, 'bs');
    }

    /**
     * Prepares the brush for point cloud coloring, do all async tasks of loading remote sources in this function call. This calls
     * provides information about the node's placement in the point cache as well by specifying the parent and children nodes this
     * node will receive when placed in the cachen.
     *
     * @param {GeoTransform} params.geoTransform The geo transform instance for the loaded resource.
     * @param {Number[]} params.renderSpaceBounds The render space bounds of the particular point buffer being prepped for painting.
     * @param {object} params.bufferStats The collected stats for the buffer that needs painting.
     * @param {object} params.pointCloudBufferStats The cumulative stats of the point cloud, after the buffer stats have been merged in.
     * @param {object} parent The parent node for placement in point buffer cache, the passed object is considered opaque and is similar to what
     * {@link BaseBrush#stagingAttributes} returns.
     * @param {object[]} children All children nodes under this node in point buffer cache, an array of opaque children nodes as returned by
     * the {@link BaseBrush#stagingAttributes} function.
     */
    async prepare(params, parent, children) {
        throw new Error('Not implemented');
    }


    /**
     * This method is called right before the brush is un-prepared and after its done coloring the current point buffer. Anything
     * returned from this call is stored along with the point buffer in the point buffer cache.  These parameters are later
     * passed to the {@link BaseBrush#bufferNeedsRecolor} method to determine if any of the already loaded buffers need to be recolored
     * because of changes seen in the current buffer.
     *
     * @param {object} parentNode The node under which the current point buffer will be staged in the point buffer cache.  The attributes
     * under this object will be the same as what this function returns.
     * @param {object[]} childrenNodes Children nodes, if any, that will be placed as children of this node in point buffer cache hierarchy.
     * @param {object} params Per buffer parameters needed to color nodes.
     * @param {GeoTransform} params.geoTransform The geo transform instance for the loaded resource.
     * @param {Number[]} params.renderSpaceBounds The render space bounds of the particular point buffer being prepped for painting.
     * @param {object} params.bufferStats The collected stats for the buffer that needs painting.
     * @param {object} params.pointCloudBufferStats The cumulative stats of the point cloud, after the buffer stats have been merged in.
     * @return {object} An arbitrary object stored in the point buffer cache.
     */
    stagingAttributes(parentNode, childrenNodes, params) {
        throw new Error('Not implemented');
    }

    /**
     * The node selection strategy used to collect nodes to determine which nodes may need a re-color.
     * @return A {@link NodeSelectionStrategy} indicating how to determine nodes for filtering.
     */
    nodeSelectionStrategy() {
        throw new Error('Not implemented');
    }

    /**
     * Determines if the passed node needs to be recolored.  The set of nodes for which this function is called are determined
     * by {@link BaseBrush#nodeSelectionStrategy} function.  Every node for which this function returns true is passed through
     * the same painting pipeline as new buffers.
     *
     * @param node
     * @param stagedAttributes
     * @param params
     */
    bufferNeedsRecolor(node, stagedAttributes, params) {
        throw new Error('Not implemented');
    }

    /**
     * Unprepare the prepare phase for a point buffer, any resources allocated in {@link BaseBrush#prepare} call may be released here.
     * @param params Per buffer parameters, same as the parameters passed to {@link BaseBrush#prepare}.
     * @param {GeoTransform} params.geoTransform The geo transform instance for the loaded resource.
     * @param {Number[]} params.renderSpaceBounds The render space bounds of the particular point buffer being prepped for painting.
     * @param {object} params.bufferStats The collected stats for the buffer that needs painting.
     * @param {object} params.pointCloudBufferStats The cumulative stats of the point cloud, after the buffer stats have been merged in.
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
}
