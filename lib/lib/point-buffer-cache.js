/**
 * @module point-buffer-cache
 *
 */

import { compressColor, checkParam } from './util';
import { NodeSelectionStrategy } from './brush';
import { Promise } from 'bluebird';

/**
 * @typedef {Object} DownloadedBufferParams
 * Parameters associated with buffers downloaded from entwine.
 * @property {Float32Array} data Buffer as downloaded from entwine with all fields already normalized to float.
 * @property {Number} totalPoints Total number of points in buffer.
 * @property {Number[]} renderSpaceBounds The render space bounds of the buffer.
 * @property {BufferStats} bufferStats The stats for this buffer.
 * @property {BufferStats} pointCloudBufferStats Point cloud resource wide buffer stats after the current stats have been merged.
 * @property {String} treePath The path of the buffer in the render tree hierarchy. e.g. <tt>R12</tt>.
 * @property {Object[]} schema Schema definition for the resource.
 * @property {GeoTransform} geoTransform The geo transform associated with this buffer.
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
 */
export class PointBufferCache {
    /**
     * Construct a point buffer cache object.
     */
    constructor() {
        this.nodes = {}; // nodes mapping from ID to node content.
    }

    /**
     * @callback bufferReadyForRendererCallback
     * @param {Float32Array} buffer A buffer ready for renderer.
     */

    /**
     * Push a new buffer into the cache.  This function will walk the tree and determine where the newly downloaded buffer
     * needs to be placed.  This function also determines the buffers that would need to have their color updated.
     * @param {DownloadedBufferParams} downloadedBufferParams The buffer parameters for downloaded buffer.
     * @param {BaseBrush[]} brushes An array of brushes currently in use.
     * @param {bufferReadyForRendererCallback} bufferReadyCB This function is called when the buffer has been prepared for the
     * renderer. This means that the buffer has been colored and is ready for display.
     * @return {Promise}
     */
    async push(downloadedBufferParams, brushes, bufferReadyCB) {
        const
            data = checkParam(downloadedBufferParams, 'data'),
            schema = checkParam(downloadedBufferParams, 'schema'),
            treePath = checkParam(downloadedBufferParams, 'treePath'),
            totalPoints = checkParam(downloadedBufferParams, 'totalPoints'),
            geoTransform = checkParam(downloadedBufferParams, 'geoTransform'),
            renderSpaceBounds = checkParam(downloadedBufferParams, 'renderSpaceBounds'),
            bufferStats = checkParam(downloadedBufferParams, 'bufferStats'),
            pointCloudBufferStats = checkParam(downloadedBufferParams, 'pointCloudBufferStats');

        const brushSpecs = brushes.filter(b => b != null).map(b => b.brushSpec); // Need to maintain order of brushes.
        const brushMap = new Map(brushes.filter(b => b != null).map(b => [b.brushSpec, b]));

        // Determine who are the node's children and parents.
        const parentNode = treePath.length > 1 ? this.nodes[treePath.substring(0, treePath.length - 1)] : null;
        const childrenNodes = Array.from(new Array(8), (v, i) => this.nodes[treePath + i]).filter(b => b != null);

        // figure out per brush staging parameters for parent and children, we'd need it several times going forward.
        const perBrushStagingAttributes = {};
        brushMap.forEach((brush, brushSpec) => {
            perBrushStagingAttributes[brushSpec] = {
                parentNode: parentNode ? parentNode.stagingAttributes[brushSpec] : null,
                childrenNodes: childrenNodes.map(c => c.stagingAttributes[brushSpec])
            };
        });

        const bufferParams = { geoTransform, renderSpaceBounds, bufferStats, pointCloudBufferStats };

        // Prepare each brush.
        await Promise.all(brushSpecs.map(bs => {
            const brush = brushMap.get(bs);
            return brush.prepare(perBrushStagingAttributes[bs].parentNode,
                perBrushStagingAttributes[bs].childrenNodes, bufferParams);
        }));

        // Each brush takes a single float value, determine our new point size to make room for channel colors, our base point
        // size is always 3 floats for the X, Y, Z.
        const newPointSize = 3 + brushSpecs.length;
        const outputBuffer = new Float32Array(totalPoints * newPointSize);

        // Color the point buffer
        await this._copyAndColorBuffer(outputBuffer, downloadedBufferParams, brushes, perBrushStagingAttributes);

        // Before we un-prepare this buffer, we need to collect the staging parameters.
        const thisBufferStagingAttributes = {};
        brushMap.forEach((brush, brushSpec) => {
            const attributes = brush.stagingAttributes(perBrushStagingAttributes[brushSpec].parentNode,
                perBrushStagingAttributes[brushSpec].childrenNodes, bufferParams);
            thisBufferStagingAttributes[brushSpec] = attributes;
        });

        // un-prepare this buffer
        await Promise.all(brushSpecs.map(bs => {
            const brush = brushMap.get(bs);
            return brush.unprepare(bufferParams);
        }));

        // Cache this buffer
        this.nodes[treePath] = {
            stagingAttributes: thisBufferStagingAttributes,
            data: outputBuffer
        };

        // At this point the buffer is done coloring
        // TODO: Attributes and uniforms for shaders
        //
        if (bufferReadyCB) {
            bufferReadyCB(outputBuffer);
        }

        // Determine this buffers impact on already loaded buffers.
        const impactedNodes = [];
        brushMap.forEach((brush, brushSpec, index) => {
            const {strategy, params} = brush.nodeSelectionStrategy();
            let nodeSet = [];
            if (strategy === NodeSelectionStrategy.ALL) {
                // All nodes expect current node
                nodeSet = Object.keys(this.nodes)
                    .filter(id => id != treePath)
                    .map(id => this.nodes[id]);
            }
            else if (strategy === NodeSelectionStrategy.ANCESTORS) {
                nodeSet = this._nodeAncestors(treePath);
            }

            // If this strategy has an impact set, test these nodes.
            if (nodeSet.length > 0) {
                for (let i = 0, il = nodeSet.length ; i < il ; i ++) {
                    const node = nodeSet[i];
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

    async _copyAndColorBuffer(outputBuffer, inputBufferParams, brushes, perBrushStagingAttributes) {
        const {
            totalPoints, data, schema
        } = inputBufferParams;

        const point = {};
        const numItems = schema.length;
        const pointOffsets = schema.map(({name}, index) => {
            return [name.toLowerCase(), index];
        });

        const decomposePoint = (index) => {
            const offset = index * numItems;
            for (let i = 0 ; i < numItems ; i ++) {
                const [name, fieldOffset] = pointOffsets[i];
                point[name] = data[offset + fieldOffset];
            }
            return point;
        };

        const cleanedUpBrushes = brushes.filter(b => b != null);
        const outputPointSize = 3 + cleanedUpBrushes.length;

        const colorPoints = (start, end) => {
            return Promise.delay(0).then(() => {
                let writeOffset = start * outputPointSize;
                let color = [0, 0, 0];

                for (let i = start; i < end; i++) {
                    const p = decomposePoint(i);
                    outputBuffer[writeOffset + 0] = p.x;
                    outputBuffer[writeOffset + 1] = p.y;
                    outputBuffer[writeOffset + 2] = p.z;

                    for (let bi = 0, bl = cleanedUpBrushes.length; bi < bl; bi++) {
                        const brush = cleanedUpBrushes[bi];
                        brush.colorPoint(color, p);

                        outputBuffer[writeOffset + 3 + bi] = compressColor(color);
                    }

                    writeOffset += outputPointSize;
                }
            });
        };

        const coloringTasks = [];
        const POINTS_PER_TASK = 1000;

        for (let i = 0 ; i < totalPoints ; i += POINTS_PER_TASK) {
            const start = i;
            const end = Math.min(start + POINTS_PER_TASK, totalPoints);

            coloringTasks.push(colorPoints(start, end));
        }

        return await Promise.all(coloringTasks);
    }

    _runRecolorTasks(impactedNodes) {

    }
}

