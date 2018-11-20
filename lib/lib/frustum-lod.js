// greyhound-lod.js
// Greyhound data fetch as a OctTree
//

var EventEmitter = require("events").EventEmitter,
    vec3 = require("gl-matrix").vec3,
    vec4 = require("gl-matrix").vec4,
    mat4 = require("gl-matrix").mat4,
    _ = require("lodash"),
    util = require("./util"),
    TriggeredDispatch = util.TriggeredDispatch;


import Promise from 'bluebird';
import {PointBufferCache} from "./point-buffer-cache";
import { Device } from './device';

/**
 * A class that fetches and caches the tree hierarchy requests.
 */
class TreeInfoCache {
    /**
     * Construct an instance of TreeInfoCache
     * @param {BaseLoader} loader The point loader to use for querying info.
     * @param {GeoTransform} geoTransform The GeoTransform for current data-set.
     * @param {Number} baseDepth The base query depth, the minimum depth that is used as a starting point.
     */
    constructor(loader, geoTransform, baseDepth) {
        this.loader = loader;
        this.geoTransform = geoTransform;
        this.baseDepth = baseDepth;
        this.nodesCache = {};
        this.loadedNodes = new Set();

        const [dx] = geoTransform.coordinateSpaceCenter('geo');
        this.rangeX = dx;
    }

    static _key(node) {
        let bounds = node.bounds();
        let key = bounds.map(v => v.toFixed(3)).join(":") + node.depthBegin + ":" + node.depthEnd;
        return key;
    }

    _store(k, v) {
        this.nodesCache[k] = v;
    }

    _isPrefetchLevel(node) {
        let stepSize = FrustumLODNodePolicy.TREE_PREFETCH_STEP;

        // this node is a prefetch level if its the base node, or an increment of stepSize above it, not that for an example
        // where step size = 3, baseDepth = 8, the levels returned by hierarchy query are 8, 9->10, 10->11, so to figure if a
        // level is prefetch level, we need to know if a level is (depthEnd - baseLevel) % (step + 1), so that things like 8, 12, 16 return true
        return (node.depthEnd === this.baseDepth) ||
            ((node.depthEnd - this.baseDepth) % (stepSize) === 0);
    }

    _loadInfo(node, data) {
        // cache all these keys!
        // the current node is already cached
        let children = node.subdivide();
        let nodeNameToIndex = {
            "sed": 0, "swd": 1,
            "seu": 2, "swu": 3,

            "ned": 4, "nwd": 5,
            "neu": 6, "nwu": 7
        };

        if (children.length === 1) {
            // the n is the sum of all nodes ns
            let sum = _.reduce(data, (acc, n) => {
                return acc + (n.n == null ? 0 : n.n);
            }, 0);

            let k = TreeInfoCache._key(children[0]);
            this._store(k, sum);
        }
        else {
            _.forEach(data, (v, k) => {
                // where is this item in the list of children
                if (k !== 'n') {
                    let index = nodeNameToIndex[k];
                    let node = children[index];

                    // save this node
                    let key = TreeInfoCache._key(node);
                    this._store(key, v.n);

                    // recur down if it has more children
                    if (_.size(v) > 1) { // the 1 key we have is 'n'
                        this._loadInfo(node, v);
                    }
                }
            });
        }
        
    }

    _makeURL(node) {
        const nodeBounds = node.bounds();
        const geoBounds = this.geoTransform.transform(nodeBounds, 'render', 'geo');

        return util.joinPath(this.loader.server, "resource", this.loader.resource, "hierarchy") + "?" +
            "bounds=" + encodeURIComponent(JSON.stringify(geoBounds)) +
            "&depthBegin=" + node.depthEnd +
            "&depthEnd=" + (node.depthEnd + 1);
    }

    _makeViewURL(node) {
        const nodeBounds = node.bounds();
        const geoBounds = this.geoTransform.transform(nodeBounds, 'render', 'geo');

        return util.joinPath(this.loader.server, "http", this.loader.resource, "hierarchy") + "?" +
            "bounds=" + encodeURIComponent(JSON.stringify(geoBounds)) +
            "&depthBegin=" + node.depthEnd +
            "&depthEnd=" + (node.depthEnd + 1);
    }

    /**
     * Asynchronously load point information about a node.
     * @param {Box} node The node to query the point information about.
     * @return {Number} The total number of points available in the specified node.
     */
    async nodeInfo(node) {
        // node info works differently based on whether we're EPT or non-EPT
        if (this.loader.isEPT()) {
            const eptDepth = (node.depthBegin === 0) ? 0 : (node.depthEnd - node.baseDepth);
            const eptKey = node.eptKey();

            // we only need to fetch this node if the parent says that we have points, current node's depth is a multiple of
            // hierarchy step and we haven't already fetched this node.
            const shouldFetch =
                (eptDepth === 0 && !this.loadedNodes.has(eptKey)) ||     // is this root node?
                (this.nodesCache[eptKey] && this.nodesCache[eptKey] === -1 && !this.loadedNodes.has(eptKey));

            if (shouldFetch) {
                // currently loaded set
                // this is a prefetch level
                const eptKey = node.eptKey();
                const newItems = await this.loader.loadEPTHierarchyInfo(eptKey);

                // merge the new Items with our current node
                let current = this.nodesCache || {};
                this.nodesCache = Object.assign(current, newItems);

                this.loadedNodes.add(eptKey);
            }

            return this.nodesCache[node.eptKey()] || 0;
        }
        else {
            const k = TreeInfoCache._key(node);
            const pointCount = this.nodesCache[k];

            const stepSize = FrustumLODNodePolicy.TREE_PREFETCH_STEP;

            // if we don't know about this node yet, trying doing a prefetch
            if (pointCount == null) {
                // we don't know about this node yet, is it a pre-fetch node?
                if (this._isPrefetchLevel(node) && node.depthEnd <= node.stopSplitDepth) {
                    // yes its a pre-fetch level, so query it and load stuff up
                    const nodeBounds = node.bounds();

                    const res = await this.loader.loadHierarchyInfo(
                        nodeBounds, this.geoTransform,
                        node.depthEnd, node.depthEnd + stepSize);

                    const r = res || {n: 0};

                    this._store(k, r.n);
                    this._loadInfo(node, r);
                    return r.n;
                }
                else {
                    return 0;
                }
            }
            else {
                return pointCount;
            }
        }
    }
}

/**
 * A frustum class which abstracts details about managing and computing frustums
 */
class Frustum {
    /**
     * Construct an empty Frustum instance.
     */
    constructor() {
        this.frustumMat = mat4.create();
        this.planes = [
            vec4.create(),
            vec4.create(),
            vec4.create(),
            vec4.create(),
            vec4.create(),
            vec4.create()
        ]
    }

    /**
     * Update this object with frustum planes specified by the given projection and view matrix
     * @param proj The projection matrix
     * @param view The view matrix
     * @return {Frustum} Returns its own instance with updated results.
     */
    update(proj, view) {
        mat4.multiply(this.frustumMat, proj, view);

        let me = this.frustumMat;
        let me0 = me[ 0 ], me1 = me[ 1 ], me2 = me[ 2 ], me3 = me[ 3 ];
        let me4 = me[ 4 ], me5 = me[ 5 ], me6 = me[ 6 ], me7 = me[ 7 ];
        let me8 = me[ 8 ], me9 = me[ 9 ], me10 = me[ 10 ], me11 = me[ 11 ];
        let me12 = me[ 12 ], me13 = me[ 13 ], me14 = me[ 14 ], me15 = me[ 15 ];

        vec4.set(this.planes[0], me3 - me0, me7 - me4, me11 - me8, me15 - me12 );
        vec4.set(this.planes[1], me3 + me0, me7 + me4, me11 + me8, me15 + me12 );
        vec4.set(this.planes[2], me3 + me1, me7 + me5, me11 + me9, me15 + me13 );
        vec4.set(this.planes[3], me3 - me1, me7 - me5, me11 - me9, me15 - me13 );
        vec4.set(this.planes[4], me3 - me2, me7 - me6, me11 - me10, me15 - me14 );
        vec4.set(this.planes[5], me3 + me2, me7 + me6, me11 + me10, me15 + me14 );

        let norm = (p) => {
            const f = vec3.length(p);
            if (f > 0.001) {
                p[0] /= f;
                p[1] /= f;
                p[2] /= f;
                p[3] /= f;
            }
        };

        /*
        let m = (r, c) => this.frustumMat[(c -1) * 4 + (r - 1)];

        vec4.set(this.frustum[0], m(4, 1) + m(1,1), m(4, 2) + m(1, 2), m(4, 3) + m(1, 3), m(4,4) + m(1,4));
        vec4.set(this.frustum[1], m(4, 1) - m(1,1), m(4, 2) - m(1, 2), m(4, 3) - m(1, 3), m(4,4) - m(1,4));

        vec4.set(this.frustum[2], m(4, 1) + m(2,1), m(4, 2) + m(2, 2), m(4, 3) + m(2, 3), m(4,4) + m(2,4));
        vec4.set(this.frustum[3], m(4, 1) - m(2,1), m(4, 2) - m(2, 2), m(4, 3) - m(2, 3), m(4,4) - m(2,4));

        vec4.set(this.frustum[4], m(4, 1) + m(3,1), m(4, 2) + m(3, 2), m(4, 3) + m(3, 3), m(4,4) + m(3,4));
        vec4.set(this.frustum[5], m(4, 1) - m(3,1), m(4, 2) - m(3, 2), m(4, 3) - m(3, 3), m(4,4) - m(3,4));
        */

        this.planes.forEach(norm);
        return this;
    }
}


const nodeIndexToEPTIndexMapping = {
    0: [1, 0, 0],
    1: [0, 0, 0],
    2: [1, 0, 1],
    3: [0, 0, 1],
    4: [1, 1, 0],
    5: [0, 1, 0],
    6: [1, 1, 1],
    7: [0, 1, 1]
};


/**
 * A box class which encapsulates a node in a tree traversal
 */
class Box {
    /**
     * Construct an instance of a Box from supplied parameters.
     * @param {Number[]} bounds The bounds of the box, the coordinate space is not relevant and is dependent on the caller.
     * @param {Number} ex EPT x
     * @param {Number} ey EPT y
     * @param {Number} ez EPT z
     * @param {String} id The ID of this box.
     * @param {Number} baseDepth The base depth of the tree this box is associated with.
     * @param {Number} depthBegin The start depth for this box.
     * @param {Number} depthEnd The end depth for this box, usually depthBegin + 1.
     * @param {Box} parent Parent if not the root of the tree, null otherwise.
     * @param {Number} stopSplitDepth The depth at which the splitting stops.
     * @param {Number} hardStopDepth The absolute maximum depth to query.
     * @return {Box} The constructed box.
     */
    static fromBounds(bounds,
                      ex, ey, ez,
                      id,
                      baseDepth, depthBegin, depthEnd, parent,
                      stopSplitDepth, hardStopDepth) {
        return new Box(
            bounds[0], bounds[1], bounds[2],
            bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2],
            ex, ey, ez,
            id, baseDepth, depthBegin, depthEnd, parent,
            stopSplitDepth, hardStopDepth);
    }

    /**
     * Construct a Box instance.
     * @param {Number} x The x coordinate for the box.
     * @param {Number} y The y coordinate for the box.
     * @param {Number} z The z coordinate for the box.
     * @param {Number} w The width of the box.
     * @param {Number} h The height of the box.
     * @param {Number} d The depth of the box.
     * @param {Number} ex EPT X
     * @param {Number} ey EPT Y
     * @param {Number} ez EPT Z
     * @param {String} id The ID for the box.
     * @param {Number} baseDepth The base depth of the tree this box is associated with
     * @param {Number} depthBegin The start depth for the box.
     * @param {Number} depthEnd the end depth for the box, usually depthBegin + 1.
     * @param {Number} stopSplitDepth The depth at which the splitting stops.
     * @param {Number} hardStopDepth The absolute maximum depth to query.
     * @param {Box} parent The parent box if not a root node, null otherwise.
     */
    constructor(x, y, z, w, h, d, ex, ey, ez, id, baseDepth, depthBegin, depthEnd, parent,
        stopSplitDepth, hardStopDepth) {
        this.x = x; this.y = y; this.w = w, this.h = h;
        this.z = z; this.d = d;
        this.ex = ex; this.ey = ey; this.ez = ez;

        this.id = id || "R";
        this.depthBegin = depthBegin;
        this.depthEnd = depthEnd;
        this.parent = parent;
        this.baseDepth = baseDepth;

        this.stopSplitDepth = stopSplitDepth;
        this.hardStopDepth = hardStopDepth;

        this.radius = Math.sqrt(w * w + d * d + h * h) / 2;
        this.position = [x + w / 2, y + h / 2, z + d / 2];
    }

    _split() {
        const x = this.x, y = this.y, z = this.z;
        const w = this.w, h = this.h, d = this.d;

        const {ex, ey, ez} = this;

        let boxes = [];

        const childrenDepthBegin = (this.depthBegin === 0) ? this.depthEnd : (this.depthBegin + 1),
              childrenDepthEnd = childrenDepthBegin + 1;

        for (let i = 0 ; i < 8 ; i++) {
            let e = i & 1;
            let f = (i >> 1) & 1;
            let g = (i >> 2) & 1;

            const [ee, ef, eg] = nodeIndexToEPTIndexMapping[i];

            boxes.push(new Box(
                x + (e ? (w / 2) : 0),
                y + (f ? (h / 2) : 0),
                z + (g ? (d / 2) : 0),
                w/2, h/2, d/2,
                ex * 2 + ee,
                ey * 2 + ef,
                ez * 2 + eg,
                this.id + "" + i,
                this.baseDepth,
                childrenDepthBegin,
                childrenDepthEnd,
                this,
                this.stopSplitDepth,
                this.hardStopDepth));
        }

        return boxes;
    }

    /**
     * Get the bounds for this box, based on the given origin
     * @param {Number[]} [origin] The origin to base the position of off, defaults to 0, 0, 0.
     * @return {Number[]} The bounds of the node as a 6-vector;
     */
    bounds(origin) {
        const node = this;
        const o = origin ? origin : [0, 0, 0];

        const x = node.x + o[0],
              y = node.y + o[1],
              z = node.z + o[2];

        return [
            x, y, z,
            x + node.w, y + node.h, z + node.d
        ];
    }

    /**
     * Return the EPT key for this node
     *
     * @return {String} The EPT key in "d-x-y-z" format
     */
    eptKey() {
        // for base box, to comply with EPT we need to set depth to 0, otherwise its whatever depth - our base depth
        const d = (this.depthBegin === 0) ? 0 : (this.depthEnd - this.baseDepth);
        return d + "-" + this.ex + "-" + this.ey + "-" + this.ez;
    }

    /**
     * Subdivide a box into children boxes. Parameters stopSplitDepth and hardStopDepth control how splitting happens.
     * While the box's depth is lower than stopSplitDepth, each box is split into 8 children.  After that, the box
     * is not split, but instead is "subdivided" into a single child box with the same bounds as this box but with
     * depth ranging from current box's depth to hardStopDepth.
     *
     * @return {Box[]} An array of child boxes, could either be 8, 1 or 0 in count.
     */
    subdivide () {
        // subdivision rules:
        //
        // Is my depth past the hard limit? No subdivision.
        // Is my depth past the stop split depth? Only one child, exactly the same bounds as me, only a depth lower.
        // Am I configured for hierarchy load? Mark load as hierarchy load and children are all the children of depthToShow level.
        // For everything else, subdivide normally.
        //
        const x = this.x, y = this.y, z = this.z;
        const w = this.w, h = this.h, d = this.d;

        const {ex, ey, ez} = this;

        const depth = this.depthBegin + 1;

        let boxes = [];
        if (depth < this.stopSplitDepth) {
            // regular split, no need to do anything special, just split 8 ways
            boxes = this._split();
        }
        else if (depth === this.stopSplitDepth) {
            // bulk load to load all levels to full depth
            boxes = [
                new Box(x, y, z, w, h, d,
                    ex, ey, ez,
                    this.id + "" + 0,
                    this.baseDepth,
                    this.depthBegin + 1, this.hardStopDepth, this,
                    this.stopSplitDepth, this.hardStopDepth)
            ];
        }

        return boxes;
    }

    /**
     * Check if this box intersects a Frustum
     * @param {Frustum} frustum The frustum object to check against.
     * @param {Number[]} [offset] An option offset to apply to the box before check.
     * @return {boolean} true if box intersects with the frustum, false otherwise.
     */
    intersects(frustum, offset) {
        offset = offset || [0, 0, 0];

        let x = this.x - offset[0],
            y = this.y - offset[1],
            z = this.z - offset[2];

        let p1 = (this.p1 || vec3.create());
        let p2 = (this.p2 || vec3.create());

        this.p1 = p1;
        this.p2 = p2;

        let min = [x, y, z, 1],
            max = [x + this.w, y + this.h, z + this.d, 1];

        const planes = frustum.planes;
        for(let i = 0, il = planes.length ; i < il ; i++) {
            let plane = planes[i];

            let nx = plane[0], ny = plane[1], nz = plane[2];
            p1[0] = nx > 0 ? min[0] : max[0];
            p2[0] = nx > 0 ? max[0] : min[0];
            p1[1] = ny > 0 ? min[1] : max[1];
            p2[1] = ny > 0 ? max[1] : min[1];
            p1[2] = nz > 0 ? min[2] : max[2];
            p2[2] = nz > 0 ? max[2] : min[2];

            const p1d = vec3.dot(plane, p1) + plane[3];
            const p2d = vec3.dot(plane, p2) + plane[3];
            if (p1d < 0 && p2d < 0) {
                return false;
            }
        }
        return true;
    }
}


/**
 * Walks trees down the hierarchy and determines which nodes are visible and which aren't
 */
class TreeWalker {
    /**
     * Construct a Tree Walker instance.
     * @param {TreeInfoCache} treeInfoCache The tree info cache to query point information
     * @param {Number[]} renderSpaceTreeOffset A 3-vector specifying the render offset for the tree.
     */
    constructor(treeInfoCache,
                renderSpaceTreeOffset) {
        this.nodesInScene = {};
        this.treeInfoCache = treeInfoCache;
        this.renderSpaceTreeOffset = renderSpaceTreeOffset;

        this.activeParams = null;


        // we maintain a revision index for our iteration count, every-time we touch
        // a node during a walk, we set its revision to the current revision and then any nodes
        // that don't match our revision number at the end of the walk are removed from the
        // scene
        this.revision = 0;

        // A few temporary vectors for doing math with
        this._nodePosition = vec3.create();
    }

    _rejectNode(node, fRemove) {
    }

    _acceptNode(node, weight, revision, fAdd) {
        if (!this.nodesInScene[node.id]) {
            fAdd(node, weight);
            this.nodesInScene[node.id] = {
                node: node,
                revision: revision
            };
        }
        else {
            const r = this.nodesInScene[node.id].revision;
            if (r < revision)
                this.nodesInScene[node.id].revision = revision;
        }
    }

    _doCleanup(revision, fRemove) {
        const keys = Object.keys(this.nodesInScene);
        for (let i = 0, il = keys.length ; i < il ; i ++) {
            const k = keys[i];
            const n = this.nodesInScene[k];

            if (n.revision < revision) {
                delete this.nodesInScene[k];
                fRemove(n.node);
            }
        }
    }

    _nodeWeight(node, eye) {
        const cameraToBoxDistance = vec3.distance(eye,
            vec3.add(this._nodePosition, node.position, this.renderSpaceTreeOffset));

        // compute weight for this node, higher weights means that the buffers are loaded earlier
        // If a box is closer to us (meaning that cameraToBox distance is lower), we assign a higher weight
        // to it. Also if the ID is longer (meaning the node is lower in the tree) we assign it a higher weight
        return node.id.length / cameraToBoxDistance;
    }

    async _doWalk(node, revision) {
        // release loop here so that things can move forward in other contexts (loading buffers from server e.g.)
        await Promise.delay(0);

        // Abort if parameters were removed or we're outdated.
        if (!this.activeParams || this.activeParams.revision !== revision) {
            console.warn('early abort');
            return revision;
        }

        let {
            frustum, eye, fov, clientHeight, rejectAtScreenSize,
            fRemove, fAdd
        } = this.activeParams;

        // is this node in view?  Make sure to adjust by the tree's render space offset
        const intersects = node.intersects(frustum, this.renderSpaceTreeOffset);

        /*
        if (node.id.length == 2) {
            console.log("xx", node.id, intersects);
        }
        */

        if (!intersects)
            return this._rejectNode(node, fRemove);

        // compute the screen size of this screen
        const cameraToBoxDistance = vec3.distance(eye,
            vec3.subtract(this._nodePosition, node.position, this.renderSpaceTreeOffset));
        const radiusOnScreen = FrustumLODNodePolicy._screenSizeForBox(node, fov,
            cameraToBoxDistance, clientHeight);

        // too small to be on our screen
        if (radiusOnScreen < rejectAtScreenSize)
            return this._rejectNode(node, fRemove);

        // no points?
        const pointCount = await this.treeInfoCache.nodeInfo(node);
        if (pointCount === 0)
            return this._rejectNode(node, fRemove);

        // this node seems to pass acceptance
        this._acceptNode(node, this._nodeWeight(node, eye), revision, fAdd);

        const children = node.subdivide();
        if (children.length === 1) {
            // end of tree, accept this node
            this._acceptNode(children[0], this._nodeWeight(children[0], eye), revision, fAdd);
        }
        else if (children.length > 0) {
            // go down the tree
            await Promise.all(children.map(c => this._doWalk(c, revision)));
        }

        // otherwise don't do anything
        return revision;
    }

    /**
     * A function invoked for each node to either add or remove it.
     *
     * @callback nodeAddCallback
     * @param {Box} node The node to add or remove.
     * @param {Number} weight The weight for the node.
     */

    /**
     * A function invoked for each node to either add or remove it.
     *
     * @callback nodeRemoveCallback
     * @param {Box} node The node to add or remove.
     */

    /**
     * Perform a walk of the tree adding and removing nodes
     * @param {Box} node The root node to start walk with.
     * @param {Frustum} frustum The frustum to use for intersection detection.
     * @param {Number[]} eye The eye location.
     * @param {Number[]} target The target location.
     * @param {Number} fov The current field of view.
     * @param {Number} clientHeight The current window height.
     * @param {Number} rejectAtScreenSize The size at which to reject child nodes.
     * @param {nodeAddCallback} fAdd The callback for when adding a node.
     * @param {nodeRemoveCallback} fRemove The callback for when removing a node.
     */
    async walk(node, frustum, eye, target, fov, clientHeight, rejectAtScreenSize,
               fAdd, fRemove) {
        if (this.activeParams)
            console.warn('performing', 'Walk in progress');

        const revision = this.revision;
        this.revision ++;

        this.activeParams = {
            revision: revision,
            frustum: frustum,
            eye: eye,
            target: target,
            clientHeight: clientHeight,
            rejectAtScreenSize: rejectAtScreenSize,
            fov: fov,
            fAdd: fAdd,
            fRemove: fRemove,
        };

        const completedWithRevision = await this._doWalk(node, revision);

        // Only the revisions that make it to the end are responsible for removal
        if (completedWithRevision === this.revision - 1) {
            /*
            let s1 = '';
            for (let k in this.nodesInScene) {
                const n = this.nodesInScene[k];
                s1 = s1 + " [" + n.node.id + ":" + n.node.depthEnd + ":" + n.revision + "] "
            }

            console.log(s1);
            */

            this._doCleanup(revision, fRemove);

            let s = '';
            for (let k in this.nodesInScene) {
                const n = this.nodesInScene[k];
                s = s + " [" + n.node.id + ":" + n.node.depthEnd + ":"  + n.node.eptKey() + ":" + n.revision + "] "
            }
            // Only remove params if we are still responsible for it.
            if (revision === this.activeParams.revision) {
                this.activeParams = null;
            }
        }
    }


    /**
     * Clear all nodes the tree nodes about, calling fRemove on each node.
     *
     * @param fRemove {nodeRemoveCallback} The callback to call for each node removal.
     */
    clearAllNodes(fRemove) {
        const nodes = this.nodesInScene;
        this.nodesInScene = [];

        Object.values(nodes).forEach(n => {
            fRemove(n.node);
        });
    }
}


/**
 *  A buffer loading policy which uses view frustum for loading LOD'd buffers
 *  @extends EventEmitter
 */
export class FrustumLODNodePolicy extends EventEmitter {
    /**
     * Construct an instance for FrustumLODNOdePolicy
     * @param {String} namespace The namespace this policy belongs to, the namespace distinguish multiple loaded policies.
     * @param {BaseLoader[]} loaders An array of loaders to use, a point cloud loader as well as a transform loader is required
     * @param {Object} renderer The renderer object.
     * @param {Object} params Additional parameters to initialize this policy with.
     * @param {GeoTransform} params.geoTransform The GeoTransform for associated point cloud data set.
     * @param {Number} params.stopSplitDepth The depth at which the splitting stops.
     * @param {Number} params.hardStopDepth The absolute maximum depth to query.
     * @param {Number} [params.baseDepth] The base depth for the tree, defaults to 8.
     * @param {Number[]} [params.offset] A 3-vector specifying the tree render offset in render space.
     */
    constructor(namespace, loaders, renderer, params) {
        super();

        this.namespace = namespace;
        this.renderer = renderer;
        this.loaders = loaders;

        this.geoTransform = util.checkParam(params, 'geoTransform');

        this.geoOrigin = this.geoTransform.coordinateSpaceCenter('geo');
        this.renderBounds = this.geoTransform.coordinateSpaceBounds('render');

        this.stopSplitDepth = util.checkParam(params, 'stopSplitDepth');
        this.hardStopDepth = util.checkParam(params, 'hardStopDepth');
        this.isEPT = util.checkParam(params, 'isEPT', false);

        this.baseDepth = params.baseDepth || 8;
        this.renderTreeOffset = params.offset || [0, 0, 0];

        // find the point loader, we need this to pre-query certain things
        this.pointLoader = loaders.find(e => e.constructor.provides === "point-buffer");
        if (!this.pointLoader)
            throw new Error("No point loader specified.  A point loader needs to be available in the list of loaders");

        // create a tree info cache
        this.treeInfoCache = new TreeInfoCache(
            this.pointLoader, this.geoTransform, this.baseDepth, this.geoOrigin
        );

        // The tree walker
        this.treeWalker = new TreeWalker(this.treeInfoCache, this.renderTreeOffset);

        // A frustum to intersect against
        this.frustum = new Frustum();

        // add in our loaders, namespace'd!
        this.loaders.forEach((loader) => {
            // the renderer expects loaders to have certain attributes:
            // key -> the key used to lookup buffer loaders
            // provides -> what does it provide? a point-buffer or a transform
            // load -> the method that actually does the loading
            // all these fields are expected to be "static" fields of a class, we can just emulate our loaders here

            let newLoader = {
                provides: loader.constructor.provides,
                key: this.namespace + "/" + loader.constructor.key,
                load: loader.constructor.load
            };

            console.log("policy:", this.namespace, "adding loader:", newLoader);
            this.renderer.addLoader(newLoader);
        });

        console.log("FrustumLODNodePolicy initialized with render bounds:", this.renderBounds, "normalize?", "always");
    }

    /**
     * Stops the policy and removes any associated event listeners.
     */
    stop() {
        this.renderer.removePropertyListener(this.propListener);
        this.renderer.removePropertyListener(this.cameraPropsListener);
    }

    /**
     * A hooked reload callback function.
     *
     * @callback hookedReloadCallback
     */

    /**
     * Performs a hooked reload, any current buffer loads will be aborted, all loaded buffers are cleared, then the
     * supplied function is called (sync'ly) followed by a reload of current scene.
     * @param {hookedReloadCallback} f The function called during the hooked reload process.
     */
    hookedReload(f) {
        if (this.abortLoad)
            this.abortLoad();

        if (this.clearAll)
            this.clearAll();

        PointBufferCache.getInstance().flush();

        this.nodes = [];

        if (f) f.call(null);

        if (this.simulateVal)
            this.simulateVal();
    }

    _makeId(node) {
        // make sure the points are in a valid coordinate system, offset them
        // by the center
        const bounds = node.bounds();
        const queryParams = {
            renderSpaceBounds: bounds,
            geoTransform: this.geoTransform,
            depthBegin: node.depthBegin,
            depthEnd: node.depthEnd,
            treePath: node.id,
            eptKey: node.eptKey()
        };

        let id = {};
        this.loaders.forEach(e => {
            id[this.namespace + "/" + e.constructor.key] = e.queryFor(queryParams);
        });

        return id;
    }

    _nodeGeoAndWorldBounds(node) {
        return node.geoAndWorldBounds(this.geoTreeOrigin);
    }

    static _screenSizeForBox(box, cameraFOV, eyeToBoxDistance, clientHeight) {
        if (box.radius > eyeToBoxDistance) {
            return clientHeight;
        }
        else {
            let fov = cameraFOV / 2 * Math.PI / 180.0;
            let pr = 1 / Math.tan(fov) * box.radius / Math.sqrt(eyeToBoxDistance * eyeToBoxDistance -
                    box.radius * box.radius);
            return clientHeight * pr;
        }
    }

    static _figureAspect() {
        const width = window.innerWidth,
              height = window.innerHeight,
              aspect = (width > height) ? width / height : height / width;

        return [width, height, aspect];
    }

    async _loadNode (node) {
        const nodeBounds = node.bounds();

        let queryParams = {
            renderSpaceBounds: nodeBounds,
            geoTransform: this.geoTransform,
            depthBegin: node.depthBegin,
            depthEnd: node.depthEnd,
            treePath: node.id,
            eptKey: node.eptKey()
        };

        let params = this.pointLoader.queryFor(queryParams);
        return await this.pointLoader.constructor.load(params, {weight: 1});
    };

    async _loadRootNode() {
        const [x1, y1, z1, x2, y2, z2] = this.renderBounds;

        const baseBox = new Box(
            x1, y1, z1, x2 - x1, y2 - y1, z2 - z1,
            0, 0, 0,
            "R", this.baseDepth,
            0, this.baseDepth, null,
            this.stopSplitDepth,
            this.hardStopDepth
        );

        return await this._loadNode(baseBox);
    }

    /**
     * Start the node policy, this will start monitoring the current view and pulling and submitting
     * buffers to the renderer.
     */
    async start() {
        // first things first, download the meta information file and see what
        // we're dealing with
        const geoBounds = this.geoBounds;

        // although we have bounding box here provided to us by the user, we should
        // always simulate this as an async thing, since certain policies will
        // probably fetch it from the server.
        setTimeout(() => this.emit("bbox", geoBounds));

        var startDepth = this.baseDepth;

        this.nodes = [];
        const rootNodeData = await this._loadRootNode();
        this.updateTrigger = new TriggeredDispatch(200, (view) => {
            if (!FrustumLODNodePolicy.pauseView)
                this._updateView(view)
        });

        // setup some functions for trigger management
        //
        this.simulateVal = () => {
            this.updateTrigger.simulateVal();
        };

        this.clearAll = () => {
            this.treeWalker.clearAllNodes(n => this.renderer.removePointBuffer(this._makeId(n)));
        };

        this.abortLoad = () => {
            //throw new Error('Not implemented');
        };

        // make sure view properties are triggered through our trigger mechanism
        this.propListener = this.renderer.addPropertyListener(["view"],
            (view) => this.updateTrigger.val(view, rootNodeData));
    }

    async _updateView(view, rootNodeData) {
        if (!view)
            return;

        // figure out view and target position
        //
        const eye = view.eye;
        const target = view.target;
        const cameras = view.cameras;

        if (eye === null || target === null || cameras == null)
            return;

        // first find the active camera
        var camera = _.find(cameras, 'active');
        if (!camera)
            return;

        if (camera.type !== "perspective") {
            console.log("FrustumLODNodePolicy only supports perspective cameras, active camera is not perspective.");
            return;
        }

        // setup current projection and view matrices
        const near = camera.near || 1;
        const far = camera.far || 10000.0;
        const fov = camera.fov || 70;

        let [clientWidth, clientHeight, aspect] = FrustumLODNodePolicy._figureAspect();

        const baseBox = Box.fromBounds(this.renderBounds, 0, 0, 0,
            "R", this.baseDepth,
            0, this.baseDepth, null,
            this.stopSplitDepth, this.hardStopDepth);

        console.log(this.renderBounds, this.baseDepth, this.stopSplitDepth, this.hardStopDepth);
        console.log(baseBox);

        // Figure our current projection and view matrices
        const proj = mat4.perspective(mat4.create(), fov * Math.PI / 180.0, aspect, near, far);
        const viewMatrix = mat4.lookAt(mat4.create(), eye, target, [0, 1, 0]);

        // Update our frustum for new view
        this.frustum.update(proj, viewMatrix);
        this.treeWalker.walk(
            baseBox,
            this.frustum,
            eye, target,
            fov, clientHeight,
            clientHeight * Device.caps().nodeRejectionRatio,
            (node, weight) => this.renderer.addPointBuffer(this._makeId(node), {weight: weight}),
            (node) => {
                this.renderer.removePointBuffer(this._makeId(node))

                // Also remove from cache
                PointBufferCache.getInstance().remove(node.treePath);
            }
        );

        // notify all listeners that we are done listening
        this.emit("view-changed", {
            eye: eye, target: target
        });
    }
}

FrustumLODNodePolicy.TREE_PREFETCH_STEP = 6;

var mr = function(v, s, e, os, oe) {
    let f = (e - v) / (e - s);
    return os + (oe - os) * f;
};

var debugVisible = function(ns, baseBox) {
    var nodes = ns.slice();
    nodes.reverse();

    let W = 256,
        H = 256;

    let canvas = document.getElementById("visible-box");
    if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        canvas.style.cssText = "position:absolute;left:0;top:30px";

        document.body.appendChild(canvas);
    }

    let ctx = canvas.getContext("2d");
    let maxWeight = Math.max.apply(null, nodes.map(n => n.weight));

    ctx.clearRect(0, 0, W, H);

    nodes.forEach(function(n) {
        let sx = mr(n.x, baseBox.x, baseBox.x + baseBox.w, 0, W);
        let sz = mr(n.z, baseBox.z, baseBox.z + baseBox.d, 0, H);

        let ex = mr(n.x + n.w, baseBox.x, baseBox.x + baseBox.w, 0, W);
        let ez = mr(n.z + n.d, baseBox.z, baseBox.z + baseBox.d, 0, H);

        let r = (maxWeight === 0 ? 0 : (n.weight / maxWeight));

        let x = ex, y = ez,
            w = sx - ex,
            h = sz - ez,
            col = r * 0.1;

        ctx.fillStyle = "rgba(255,255,255," + col + ")"
        ctx.fillRect(x, y, w, h);
    });
};

export class MultiPolicyContainer extends EventEmitter {
    constructor(policies) {
        super();
        this.policies = policies;
    }

    async start() {
        let lastEmitted = {"view-changed": [],
                           "bbox": []};
        let totalNeeded = this.policies.length;

        let wrapEvents = (p) => {
            let key = p.namespace;
            if (!key)
                throw new Error("Cannot handle policy events, if no namepsace is set");
            
            p.on("view-changed", (view) => {
                this.emit("view-changed/" + key, view);
                this.emit("view-changed/any", view);

                let le = lastEmitted["view-changed"];

                le.push([key, view]);
                if (le.length === totalNeeded) {
                    this.emit("view-changed/all", le);
                    le.length = 0;
                }
                    
            });

            p.on("bbox", (bbox) => {
                this.emit("bbox/" + key, bbox);
                this.emit("bbox/any", bbox);

                let le = lastEmitted["bbox"];

                le.push([key, bbox]);
                if (le.length === totalNeeded) {
                    this.emit("bbox/all", le);
                    le.length= 0;
                }
            });
        };

        return Promise.all(this.policies.map(p => {
            wrapEvents(p);
            return p.start();
        }));
    }
}
