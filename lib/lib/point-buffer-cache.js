/**
 * @module point-buffer-cache
 *
 */

import { NodeSelectionStrategy } from './brush';

/**
 * @typedef {Object} DownloadedBufferParams
 * Parameters associated with buffers downloaded from entwine.
 * @property {Float32Array} data Buffer as downloaded from entwine with all fields already normalized to float.
 * @property {Number} totalPoints Total number of points in buffer.
 * @property {Number[]} renderSpaceBounds The render space bounds of the buffer.
 * @property {BufferStats} bufferStats The stats for this buffer.
 * @property {BufferStats} pointCloudBufferStats Point cloud resource wide buffer stats after the current stats have been merged.
 * @property {String} treePath The path of the buffer in the render tree hierarchy. e.g. <tt>R12</tt>.
 */

/**
 * @typedef {Object} CachedNodeInfo
 * Per node info maintained by {@linkcode PointBufferCache}.
 * @property {Object.<String, Object>} stagingAttributes Arbitrary per buffer per brush staging attributes.
 * @property {Float32Array} data Processed buffer data (i.e. per brush colors have been applied).
 */

/**
 * This class caches downloaded point buffers and makes sure that existing buffer colors
 * are correctly updated.
 * @property {Object.<String, CachedNodeInfo>} nodes Map of cached nodes.
 * @property {GeoTransform} A geo transform instance this cache was instantiated with.
 */
class PointBufferCache {
    /**
     * Construct a point buffer cache object.
     * @param {GeoTransform} geoTransform Geo transform for the resource for which this cache is managing buffers.
     */
    constructor(geoTransform) {
        this.nodes = {}; // nodes mapping from ID to node content.
        this.geoTransform = geoTransform;
    }

    /**
     * Push a new buffer into the cache.  This function will walk the tree and determine where the newly downloaded buffer
     * needs to be placed.  This function also determines the buffers that would need to have their color updated.
     * @param {DownloadedBufferParams} downloadedBufferParams The buffer parameters for downloaded buffer.
     * @param {BaseBrush[]} brushes An array of brushes currently in use.
     * @return {Promise}
     */
    async push(downloadedBufferParams, brushes) {
        const { treePath, totalPoints } = bufferParams;

        const brushSpecs = brushes.filter(b => b != null).map(b => b.brushSpec); // Need to maintain order of brushes.
        const brushMap = new Map(brushes.filter(b => b != null).map(b => [b.brushSpec, b]));

        // Determine who are the node's children and parents.
        const parentNode = treePath.length > 1 ? this.nodes[treePath.substring(0, treePath.length - 1)] : null;
        const childrenNodes = Array.from(new Array(8), (v, i) => this.nodes[treePath + i]).filter(b => b != null);

        // figure out per brush staging parameters for parent and children, we'd need it several times going forward.
        const perBrushStagingAttributes = {};
        brushMap.forEach((brush, brushSpec) => {
            perBrushStagingAttributes[brushSpec] = {
                parentNode: parentNode.stagingAttributes[brushSpec],
                childrenNodes: childrenNodes.map(c => c.stagingAttributes[brushSpec])
            };
        });

        const bufferParams = {
            geoTransform: this.geoTransform,
            renderSpaceBounds: downloadedBufferParams.renderSpaceBounds,
            bufferStats: downloadedBufferParams.bufferStats,
            pointCloudBufferStats: downloadedBufferParams.pointCloudBufferStats
        };

        // Prepare each brush.
        await Promise.all(brushSpecs.map(bs => {
            const brush = brushMap[bs];
            return brush.prepare(bufferParams, perBrushStagingAttributes[bs].parentNode, perBrushStagingAttributes[bs].childrenNodes);
        }));

        // Each brush takes a single float value, determine our new point size to make room for channel colors, our base point
        // size is always 3 floats for the X, Y, Z.
        const newPointSize = 3 + brushSpecs.length;
        const outputBuffer = new Float32Array(totalPoints * newPointSize)

        // Color the point buffer
        await this._copyAndColorBuffer(outputBuffer, downloadedBufferParams.data, brushes, perBrushStagingAttributes);

        // Before we un-prepare this buffer, we need to collect the staging parameters.
        const thisBufferStagingAttributes = {};
        brushMap.forEach((brush, brushSpec) => {
            const attributes = brush.stagingAttributes(bufferParams,
                perBrushStagingAttributes[brushSpec].parentNode, perBrushStagingAttributes[brushSpec].childrenNodes);
            thisBufferStagingAttributes[brushSpec] = attributes;
        });

        // un-prepare this buffer
        await Promise.all(brushSpecs.map(bs => {
            const brush = brushMap[bs];
            return brush.unprepare(bufferParams);
        }));

        // Cache this buffer
        this.nodes[treePath] = {
            stagingAttributes: thisBufferStagingAttributes,
            data: outputBuffer
        };

        // At this point the buffer is done coloring
        // TODO: Notify caller that we are done with this buffer and its ready for coloring
        //


        // Determine this buffers impact on already loaded buffers.
        const impactedNodes = [];
        brushMap.forEach((brush, brushSpec, index) => {
            const {strategy, params} = brush.nodeSelectionStrategy();
            let nodeSet = [];
            if (strategy === NodeSelectionStrategy.ALL) {
                nodeSet = Object.values(this.nodes);
            }
            else if (strategy === NodeSelectionStrategy.ANCESTORS) {
                nodeSet = this._nodeAncestors(treePath);
            }

            // If this strategy has an impact set, test these nodes.
            if (nodeSet.length > 0) {
                for (let i = 0, il = nodeSet.length ; i < il ; i ++) {
                    const node = nodeSet[nodeId];
                    const brushStagingAttributes = node.stagingAttributes[brushSpec];

                    // if we don't have any staging attributes for the buffer it means that we haven't
                    // colored this buffer with this brush yet and therefore would need a re-color.
                    const hasImpact = brushStagingAttributes == null ? true :
                        brush.bufferNeedsRecolor(bufferParams, params, brushStagingAttributes);

                    if (hasImpact) {
                        impactedNodes.push([brush, node, index]);
                    }
                }
            }
        });

        // If we have impacted nodes we need to re-color them
        await this._runRecolorTasks(impactedNodes);
    }

    _nodeAncestors(treePath) {
        let tp = treePath;
        const ret = [];
        if (tp.length > 1) {
            // strip out our ID
            tp = tp.substring(0, tp.length - 1);
            while (tp.length > 0) {
                const node = this.nodes[tp];
                if (node) ret.push(node);
                tp = tp.substring(0, tp.length - 1);
            }
        }
        return ret;
    }

    _copyAndColorBuffer(outputBuffer, inputBuffer, brushes, perBrushStagingAttributes) {

    }

    _runRecolorTasks(impactedNodes) {

    }
}

