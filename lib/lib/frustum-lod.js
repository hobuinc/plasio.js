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
        const k = TreeInfoCache._key(node);
        const pointCount = this.nodesCache[k];

        const stepSize = FrustumLODNodePolicy.TREE_PREFETCH_STEP;

        // if we don't know about this node yet, trying doing a prefetch
        if (pointCount == null) {
            // we don't know about this node yet, is it a pre-fetch node?
            if (this._isPrefetchLevel(node) && node.depthEnd < node.stopSplitDepth) {
                // yes its a pre-fetch level, so query it and load stuff up
                const nodeBounds = node.bounds();
                console.log("TREE: PREFETCH! ", node.id, node.depthEnd, "->", node.depthEnd + stepSize);

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

/**
 * A frustum class which abstracts details about managing and computing frustums
 */
class Frustum {
    /**
     * Construct an empty Frustum instance.
     */
    constructor() {
        this.frustumMat = mat4.create();
        this.frustum = [
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

        var m = (r, c) => this.frustumMat[(c -1) * 4 + (r - 1)];

        var norm = (p) => {
            const f = vec3.length(p);
            if (f > 0.001) {
                p[0] /= f;
                p[1] /= f;
                p[2] /= f;
                p[3] /= f;
            }
        };

        vec4.set(this.frustum[0], m(4, 1) + m(1,1), m(4, 2) + m(1, 2), m(4, 3) + m(1, 3), m(4,4) + m(1,4));
        vec4.set(this.frustum[1], m(4, 1) - m(1,1), m(4, 2) - m(1, 2), m(4, 3) - m(1, 3), m(4,4) - m(1,4));

        vec4.set(this.frustum[2], m(4, 1) + m(2,1), m(4, 2) + m(2, 2), m(4, 3) + m(2, 3), m(4,4) + m(2,4));
        vec4.set(this.frustum[3], m(4, 1) - m(2,1), m(4, 2) - m(2, 2), m(4, 3) - m(2, 3), m(4,4) - m(2,4));

        vec4.set(this.frustum[4], m(4, 1) + m(3,1), m(4, 2) + m(3, 2), m(4, 3) + m(3, 3), m(4,4) + m(3,4));
        vec4.set(this.frustum[5], m(4, 1) - m(3,1), m(4, 2) - m(3, 2), m(4, 3) - m(3, 3), m(4,4) - m(3,4));

        this.frustum.forEach(norm);
        return this;
    }
}


/**
 * A box class which encapsulates a node in a tree traversal
 */
class Box {
    /**
     * Construct an instance of a Box from supplied parameters.
     * @param {Number[]} bounds The bounds of the box, the coordinate space is not relevant and is dependent on the caller.
     * @param {String} id The ID of this box.
     * @param {Number} depthBegin The start depth for this box.
     * @param {Number} depthEnd The end depth for this box, usually depthBegin + 1.
     * @param {Box} parent Parent if not the root of the tree, null otherwise.
     * @param {Number} stopSplitDepth The depth at which the splitting stops.
     * @param {Number} hardStopDepth The absolute maximum depth to query.
     * @return {Box} The constructed box.
     */
    static fromBounds(bounds, id, depthBegin, depthEnd, parent,
        stopSplitDepth, hardStopDepth) {
        return new Box(
            bounds[0], bounds[1], bounds[2],
            bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2],
            id, depthBegin, depthEnd, parent,
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
     * @param {String} id The ID for the box.
     * @param {Number} depthBegin The start depth for the box.
     * @param {Number} depthEnd the end depth for the box, usually depthBegin + 1.
     * @param {Number} stopSplitDepth The depth at which the splitting stops.
     * @param {Number} hardStopDepth The absolute maximum depth to query.
     * @param {Box} parent The parent box if not a root node, null otherwise.
     */
    constructor(x, y, z, w, h, d, id, depthBegin, depthEnd, parent,
        stopSplitDepth, hardStopDepth) {
        this.x = x; this.y = y; this.w = w, this.h = h;
        this.z = z; this.d = d;

        this.id = id || "R";
        this.depthBegin = depthBegin;
        this.depthEnd = depthEnd;
        this.parent = parent;

        this.stopSplitDepth = stopSplitDepth;
        this.hardStopDepth = hardStopDepth;

        this.radius = Math.sqrt(w * w + d * d + h * h) / 2;
        this.position = [x + w / 2, y + h / 2, z + d / 2];
    }

    _split() {
        const x = this.x, y = this.y, z = this.z;
        const w = this.w, h = this.h, d = this.d;

        let boxes = [];

        const childrenDepthBegin = (this.depthBegin === 0) ? this.depthEnd : (this.depthBegin + 1),
              childrenDepthEnd = childrenDepthBegin + 1;

        for (var i = 0 ; i < 8 ; i++) {
            let e = i & 1;
            let f = (i >> 1) & 1;
            let g = (i >> 2) & 1;

            boxes.push(new Box(
                x + (e ? (w / 2) : 0),
                y + (f ? (h / 2) : 0),
                z + (g ? (d / 2) : 0),
                w/2, h/2, d/2, this.id + "" + i,
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
        var x = this.x, y = this.y, z = this.z;
        var w = this.w, h = this.h, d = this.d;

        var depth = this.depthBegin + 1;

        var boxes = [];
        if (depth < this.stopSplitDepth) {
            // regular split, no need to do anything special, just split 8 ways
            boxes = this._split();
        }
        else if (depth === this.stopSplitDepth) {
            // bulk load to load all levels to full depth
            boxes = [
                new Box(x, y, z, w, h, d, this.id + "" + 0,
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

        let x = this.x + offset[0],
            y = this.y + offset[1],
            z = this.z + offset[2];

        var mins = [x, y, z, 1],
            maxs = [x + this.w, y + this.h, z + this.d, 1];

        var result = true;
        for(var i = 0, il = frustum.length ; i < il ; i++) {
            var plane = frustum[i];

            var nx = plane[0], ny = plane[1], nz = plane[2];

            // determine the p vertex
            var p = [mins[0], mins[1], mins[2]];
            if (nx >= 0.0) p[0] = maxs[0];
            if (ny >= 0.0) p[1] = maxs[1];
            if (nz >= 0.0) p[2] = maxs[2];

            // determine the n vertex
            var n = [maxs[0], maxs[1], maxs[2]];
            if (nx >= 0.0) n[0] = mins[0];
            if (ny >= 0.0) n[1] = mins[1];
            if (nz >= 0.0) n[2] = mins[2];

            // check if we're completely outside
            var pd = vec3.dot(plane, p) + plane[3];
            if (pd < 0) {
                return false;
            }

            // check if we intersect
            var nd = vec3.dot(plane, n) + plane[3];
            if (nd < 0) {
                result = true;
            }
        }

        return result;
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

        // A few temporary vectors for doing math with
        this._nodePosition = vec3.create();
    }

    _rejectNode(node, fRemove) {
        if (this.nodesInScene[node.id]) {
            // this node was in scene, so remove it
            const {weight} = this.nodesInScene[node.id];

            fRemove(node, weight);
            delete this.nodesInScene[node.id];
        }
    }

    _acceptNode(node, weight, fAdd) {
        if (!this.nodesInScene[node.id]) {
            // this node was in scene, so remove it
            //console.log("Accepting node: " + node.bounds().toString() + "," + weight);

            fAdd(node, weight);
            this.nodesInScene[node.id] = {
                node: node,
                weight: weight
            };
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

    async _doWalk(node) {
        if (!this.activeParams)
            return;

        let {
            frustum, eye, fov, clientHeight, rejectAtScreenSize,
            fRemove, fAdd
        } = this.activeParams;

        // is this node in view?
        if (!node.intersects(frustum))
            return this._rejectNode(node, fRemove);

        // compute the screen size of this screen
        const cameraToBoxDistance = vec3.distance(eye,
            vec3.add(this._nodePosition, node.position, this.renderSpaceTreeOffset));
        const radiusOnScreen = FrustumLODNodePolicy._screenSizeForBox(node, fov,
            cameraToBoxDistance, clientHeight);

        // too small to be on our screen
        if (radiusOnScreen < rejectAtScreenSize)
            return this._rejectNode(node, fRemove);

        console.log(node.id, radiusOnScreen);

        // no points?
        const pointCount = await this.treeInfoCache.nodeInfo(node);
        if (pointCount == 0)
            return this._rejectNode(node, fRemove);

        // this node seems to pass acceptance
        this._acceptNode(node, this._nodeWeight(node, eye), fAdd);

        const children = node.subdivide();
        if (children.length == 1) {
            // end of tree, accept this node
            this._acceptNode(children[0], this._nodeWeight(children[0], eye), fAdd);
        }
        else if (children.length > 0) {
            // go down the tree
            await Promise.all(children.map(c => this._doWalk(c)));
        }

        // otherwise don't do anything
    }

    /**
     * A function invoked for each node to either add or remove it.
     *
     * @callback nodeNotificationCallback
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
     * @param {nodeNotificationCallback} fAdd The callback for when adding a node.
     * @param {nodeNotificationCallback} fRemove The callback for when removing a node.
     */
    async walk(node, frustum, eye, target, fov, clientHeight, rejectAtScreenSize,
               fAdd, fRemove) {
        this.activeParams = {
            frustum: frustum,
            eye: eye,
            target: target,
            clientHeight: clientHeight,
            rejectAtScreenSize: rejectAtScreenSize,
            fov: fov,
            fAdd: fAdd,
            fRemove: fRemove,
        };

        await this._doWalk(node);
        this.activeParams = null;
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

        this.baseDepth = params.baseDepth || 8;
        this.renderTreeOffset = params.offset || [0, 0, 0];

        // find the point loader, we need this to pre-query certain things
        this.pointLoader = loaders.find(e => e.constructor.provides === "point-buffer");
        if (!this.pointLoader)
            throw new Error("No point loader specified.  A point loader needs to be available in the list of loaders");

        // create a tree info cache
        this.treeInfoCache = new TreeInfoCache(
            this.pointLoader, this.geoTransform, this.baseDepth, this.geoOrigin);

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

        this.nodes = [];

        if (f) f.call(null);

        if (this.simulateVal)
            this.simulateVal();
    }

    _makeId(node, weight) {
        // make sure the points are in a valid coordinate system, offset them
        // by the center
        const bounds = node.bounds();
        const queryParams = {
            renderSpaceBounds: bounds,
            geoTransform: this.geoTransform,
            depthBegin: node.depthBegin,
            depthEnd: node.depthEnd,
            weight: weight
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
        console.log(box.radius);
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
            weight: 0,
        };

        let params = this.pointLoader.queryFor(queryParams);
        return await this.pointLoader.constructor.load(params);
    };

    async _loadRootNode() {
        const [x1, y1, z1, x2, y2, z2] = this.renderBounds;
        console.log('render-bounds:', this.renderBounds);
        const baseBox = new Box(
            x1, y1, z1, x2 - x1, y2 - y1, z2 - z1,
            "R", 0, this.baseDepth, null,
            FrustumLODNodePolicy.STOP_SPLIT_DEPTH,
            FrustumLODNodePolicy.HARD_STOP_DEPTH
        );

        console.log("trying to load root node", baseBox);
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
        this.updateTrigger = new TriggeredDispatch(500, (view) => this._updateView(view));

        // setup some functions for trigger management
        //
        this.simulateVal = () => {
            this.trigger.simulateVal();
        };

        this.clearAll = () => {
            throw new Error('No implemented');
        };

        this.abortLoad = () => {
            throw new Error('No implemented');
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
        const near = camera.near || 0.01;
        const far = camera.far || 1000.0;
        const fov = camera.fov || 75;

        let [clientWidth, clientHeight, aspect] = FrustumLODNodePolicy._figureAspect();

        const baseBox = Box.fromBounds(this.renderBounds, "R", 0,
            this.baseDepth, null,
            FrustumLODNodePolicy.STOP_SPLIT_DEPTH,
            FrustumLODNodePolicy.HARD_STOP_DEPTH);

        console.log("-- -- Basebox:", baseBox);

        // Figure our current projection and view matrices
        const proj = mat4.perspective(mat4.create(), fov * Math.PI / 180.0, aspect, near, far);
        const viewMatrix = mat4.lookAt(mat4.create(), eye, target, [0, 1, 0]);

        // Update our frustum for new view
        this.frustum.update(proj, viewMatrix);

        console.time("collectNodes");
        await this.treeWalker.walk(
            baseBox,
            this.frustum,
            eye, target,
            fov, clientHeight,
            FrustumLODNodePolicy.REJECT_ON_SCREEN_SIZE_RADIUS,
            (node, weight) => this.renderer.addPointBuffer(this._makeId(node, weight)),
            (node, weight) => this.renderer.removePointBuffer(this._makeId(node, weight))
        );
        console.timeEnd("collectNodes");

        // notify all listeners that we are done listening
        this.emit("view-changed", {
            eye: eye, target: target
        });
    }
}

FrustumLODNodePolicy.REJECT_ON_SCREEN_SIZE_RADIUS = 400;
FrustumLODNodePolicy.STOP_SPLIT_DEPTH = 16;
FrustumLODNodePolicy.HARD_STOP_DEPTH = 32;
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
