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
 * @property {String} treePath The node's tree path, e.g. <tt>R121</tt>.
 * @property {Float32Array} inputBuffer Raw buffer as it was initial fed to this cache.
 * @property {BufferStats} bufferStats Buffer's stats as they were initially fed to this cache.
 * @property {Object[]} schema The resource schema.
 * @property {Number[]} renderSpaceBounds A 6-element array which stores the render space bounds of this node.
 */

/**
 * This class caches downloaded point buffers and makes sure that existing buffer colors
 * are correctly updated.
 * @property {Object.<String, CachedNodeInfo>} nodes Map of cached nodes.
 */
export class PointBufferCache {
    /**
     * Get a app wide instance of point buffer cache
     * @returns {PointBufferCache} A singleton point buffer cache instance.
     */
    static getInstance() {
        if (!PointBufferCache.instance) {
            PointBufferCache.instance = new PointBufferCache();
        }

        return PointBufferCache.instance;
    }

    /**
     * Construct a point buffer cache object.
     */
    constructor() {
        this.nodes = {}; // nodes mapping from ID to node content.
        this.recolorTasks = [];
    }

    /**
     * A callback method called to request a force refresh of the renderer when needed.
     * @callback renderRequestFn
     */

    /**
     * Point buffer cache may update buffers offline (as a result of changes to color etc.).  The cache
     * then needs to request the renderer to force update itself.  This passed function <tt>f</tt> should do that.
     * @param {renderRequestFn} f The function to call whenever the cache needs a force refresh of renderer.
     */
    setRenderRequestFn(f) {
        this.renderRequestFunction = f;
    }

    /**
     * Push a new buffer into the cache.  This function will walk the tree and determine where the newly downloaded buffer
     * needs to be placed.  This function also determines the buffers that would need to have their color updated.
     * @param {DownloadedBufferParams} downloadedBufferParams The buffer parameters for downloaded buffer.
     * @param {BaseBrush[]} brushes An array of brushes currently in use.
     * @return {Promise.<Float32Array>} The processed and colored buffer ready for rendering.
     */
    async push(downloadedBufferParams, brushes) {
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

        const bufferParams = { geoTransform, renderSpaceBounds, bufferStats, pointCloudBufferStats, treePath };

        // Prepare each brush.
        await Promise.all(brushSpecs.map(bs => {
            const brush = brushMap.get(bs);
            return brush.prepare(bufferParams, perBrushStagingAttributes[bs].parentNode,
                perBrushStagingAttributes[bs].childrenNodes);
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
            const attributes = brush.stagingAttributes(bufferParams, perBrushStagingAttributes[brushSpec].parentNode,
                perBrushStagingAttributes[brushSpec].childrenNodes);
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
            data: outputBuffer,
            treePath: treePath,
            inputBuffer: downloadedBufferParams.data,
            bufferStats: downloadedBufferParams.bufferStats,
            schema: schema,
            renderSpaceBounds: renderSpaceBounds,
            totalPoints: totalPoints
        };

        // Determine this buffers impact on already loaded buffers.
        console.time('impacted-nodes-determination');
        const impactedNodes = [];
        brushMap.forEach((brush, brushSpec, index) => {
            const {strategy, params} = brush.nodeSelectionStrategy(bufferParams);
            let nodeSet = [];
            if (strategy === NodeSelectionStrategy.ALL) {
                // All nodes expect current node
                nodeSet = Object.keys(this.nodes)
                    .filter(id => id != treePath)
                    .sort() // When sorted by their IDs nodes are sorted in their DF traversal order.
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
        console.timeEnd('impacted-nodes-determination');

        this._queueRecolorTasks(impactedNodes, bufferParams.geoTransform, bufferParams.pointCloudBufferStats);
        return outputBuffer;
    }

    /**
     * Remove a node with the given tree path from the cache.  Also removes all queued re-color tasks.
     * @param {String} treePath The tree path of the node to remove.
     */
    remove(treePath) {
        delete this.nodes[treePath];
        const newList = [];

        for (let i = 0, il = this.recolorTasks.length ; i < il ; i ++) {
            const v = this.recolorTasks[i];

            if (v[1].treePath != treePath) {
                newList.push(v);
            }
        }
        this.recolorTasks = newList;
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

                    //if (i < 5) console.log(JSON.stringify(p), color.toString(), brush.scale, brush.saturation, brush.lightness);

                    outputBuffer[writeOffset + 3 + bi] = compressColor(color);
                }

                writeOffset += outputPointSize;
            }
        };

        const coloringTasks = [];
        const POINTS_PER_TASK = 1000;

        console.time('color');
        for (let i = 0 ; i < totalPoints ; i += POINTS_PER_TASK) {
            const start = i;
            const end = Math.min(start + POINTS_PER_TASK, totalPoints);

            coloringTasks.push(colorPoints(start, end));
        }

        await Promise.all(coloringTasks);
        console.timeEnd('color');
    }

    async _recolorNode(node, brush, geoTransform, pointCloudBufferStats) {
        // Determine who are the node's children and parents.
        const {
            data, totalPoints,
            treePath, bufferStats, inputBuffer, renderSpaceBounds,
            schema, stagingAttributes
        } = node;

        await Promise.delay(0);

        const parentNode = treePath.length > 1 ? this.nodes[treePath.substring(0, treePath.length - 1)] : null;
        const childrenNodes = Array.from(new Array(8), (v, i) => this.nodes[treePath + i]).filter(b => b != null);

        const brushStagingParamsParent = parentNode ? parentNode[brush.brushSpec] : null;
        const brushStagingParamsChildren = childrenNodes.map(c => c.stagingAttributes[brush.brushSpec]);

        const bufferParams = {
            geoTransform,
            bufferStats: bufferStats,
            pointCloudBufferStats: pointCloudBufferStats,
            renderSpaceBounds: renderSpaceBounds,
            treePath: treePath,
            lastStagedAttributes: stagingAttributes[brush.brushSpec]
        };

        await brush.prepare(bufferParams, brushStagingParamsParent, brushStagingParamsChildren);

        const params = {
            schema, totalPoints,
            data: inputBuffer
        };

        await this._copyAndColorBuffer(data, params, [brush], null);
        const newStagingAttributes = brush.stagingAttributes(bufferParams, brushStagingParamsParent, brushStagingParamsChildren);
        await brush.unprepare(bufferParams);

        node.stagingAttributes[brush.brushSpec] = newStagingAttributes;
    }

    async _queueRecolorTasks(impactedNodes, geoTransform, pointCloudBufferStats) {
        await Promise.delay(10);

        for (let i = 0, il = impactedNodes.length ; i < il ; i ++) {
            const [brush, node, index] = impactedNodes[i];

            let foundIndex = -1;
            for (let j = 0, jl = this.recolorTasks.length ; j < jl && foundIndex == -1 ; j ++) {
                const [b, n, p] = this.recolorTasks[j];

                if (b.brushSpec == brush.brushSpec && n.treePath == node.treePath) {
                    foundIndex = j;
                }
            }

            // if this task is already queued, remove it, since it will be re-queued at the end.
            console.log(node.treePath, foundIndex > -1 ? 'hit' : 'miss');

            if (foundIndex >= 0)
                this.recolorTasks.splice(foundIndex, 1);

            this.recolorTasks.push([
                brush, node, { geoTransform, pointCloudBufferStats}
            ]);
        }

        if (!this._recolorRunning) {
            this._startRecolor();
        }
    }

    async _startRecolor() {
        this._recolorRunning = true;

        while(this.recolorTasks.length > 0) {
            await Promise.delay(100);

            const task = this.recolorTasks.shift()
            if (task) {
                const [
                    brush, node, params
                ] = task;

                console.log('re-processing', node.treePath);

                await this._recolorNode(node, brush, params.geoTransform, params.pointCloudBufferStats);

                // Mark buffer updated since we want the GPU to re-load it.
                node.data.update = true;

                // If we have a way to tell the renderer that we want it to refresh, do so now.
                if (this.renderRequestFunction)
                    this.renderRequestFunction();
            }
        }

        this._recolorRunning = false;
    }
}

