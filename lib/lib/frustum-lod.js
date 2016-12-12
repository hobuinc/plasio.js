// greyhound-lod.js
// Greyhound data fetch as a OctTree
//

var EventEmitter = require("events").EventEmitter,
    vec3 = require("gl-matrix").vec3,
    vec4 = require("gl-matrix").vec4,
    mat4 = require("gl-matrix").mat4,
    _ = require("lodash"),
    async = require("async"),
    util = require("./util"),
    TriggeredDispatch = util.TriggeredDispatch;

class TreeInfoCache {
    constructor(loader, geoTransform, baseDepth, center) {
        this.loader = loader;
        this.center = center;
        this.baseDepth = baseDepth;
        this.nodesCache = {};

        this.rangeX = [geoTransform.fullGeoBounds[0], geoTransform.fullGeoBounds[3]];
    }

    __vecstr(v) {
        return v[0].toFixed(3) + ":" + v[1].toFixed(3) + ":" + v[2].toFixed(3);
    }

    __key(node) {
        let x = node.x + this.center[0],
            y = node.y + this.center[1],
            z = node.z + this.center[2];

        let bbox = new gh.BBox([x, y, z],
                               [x + node.w, y + node.h, z + node.d]);

        let key = this.__vecstr(bbox.mins) + ":" + this.__vecstr(bbox.maxs) + ":" +
            node.depthBegin + ":" + node.depthEnd;

        return key;
    }

    __store(k, v) {
        this.nodesCache[k] = v;
    }

    __isPrefetchLevel(node) {
        let stepSize = FrustumLODNodePolicy.TREE_PREFETCH_STEP;

        // this node is a prefetch level if its the base node, or an increment of stepSize above it, not that for an example
        // where step size = 3, baseDepth = 8, the levels returned by heirarchy query are 8, 9->10, 10->11, so to figure if a
        // level is prefetch level, we need to know if a level is (depthEnd - baseLevel) % (step + 1), so that things like 8, 12, 16 return true
        return (node.depthEnd === this.baseDepth) ||
            ((node.depthEnd - this.baseDepth) % (stepSize) === 0);
    }

    __loadInfo(node, data) {
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

            let k = this.__key(children[0]);
            this.__store(k, sum);
        }
        else {
            _.forEach(data, (v, k) => {
                // where is this item in the list of children
                if (k !== 'n') {
                    let index = nodeNameToIndex[k];
                    let node = children[index];

                    // save this node
                    let key = this.__key(node);
                    this.__store(key, v.n);

                    // recur down if it has more children
                    if (_.size(v) > 1) { // the 1 key we have is 'n'
                        this.__loadInfo(node, v);
                    }
                }
            });
        }
        
    }

    __makeURL(node) {
        let x = node.x + this.center[0],
            y = node.y + this.center[1],
            z = node.z + this.center[2];
        let bbox = new gh.BBox([x, y, z],
                               [x + node.w, y + node.h, z + node.d]);
        let b = bbox.mins.concat(bbox.maxs);

        let t = b[1]; b[1] = b[2]; b[2] = t;
        t = b[4]; b[4] = b[5]; b[5] = t;

        return "http://" + this.loader.server + "/resource/" + this.loader.resource + "/hierarchy?" +
            "bounds=" + encodeURIComponent(JSON.stringify(b)) +
            "&depthBegin=" + node.depthEnd +
            "&depthEnd=" + (node.depthEnd + 1);
    }

    __makeViewURL(node) {
        let x = node.x + this.center[0],
            y = node.y + this.center[1],
            z = node.z + this.center[2];
        let bbox = new gh.BBox([x, y, z],
                               [x + node.w, y + node.h, z + node.d]);
        let b = bbox.mins.concat(bbox.maxs);

        let t = b[1]; b[1] = b[2]; b[2] = t;
        t = b[4]; b[4] = b[5]; b[5] = t;

        b[2] = -31000;
        b[5] = +31000;

        return "http://" + this.loader.server + "/http/" + this.loader.resource + "?" +
            "bounds=" + encodeURIComponent(JSON.stringify(b)) +
            "&depthBegin=" + node.depthEnd +
            "&depthEnd=" + (node.depthEnd + 1);
    }

    async nodeInfo(node) {
        const k = this.__key(node);
        const pointCount = this.nodesCache[k];
        const stepSize = FrustumLODNodePolicy.TREE_PREFETCH_STEP;
        const stopSplitDepth = FrustumLODNodePolicy.STOP_SPLIT_DEPTH;

        // if we don't know about this node yet, trying doing a prefetch
        if (pointCount == null) {
            // we don't know about this node yet, is it a pre-fetch node?
            if (this.__isPrefetchLevel(node) && node.depthEnd < stopSplitDepth) {
                // yes its a pre-fetch level, so query it and load stuff up
                let x = node.x + this.center[0],
                    y = node.y + this.center[1],
                    z = node.z + this.center[2];
                let bbox = new gh.BBox([x, y, z],
                                       [x + node.w, y + node.h, z + node.d]);

                console.log("TREE: PREFETCH! ", node.id, node.depthEnd, "->", node.depthEnd + stepSize);

                const res = await this.loader.loadHierarchyInfo(bbox, this.rangeX, node.depthEnd, node.depthEnd + stepSize);
                const r = res || {n: 0};

                this.__store(k, r.n);
                this.__loadInfo(node, r);

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

class Frustum {
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
        return this.frustum;
    }
}


class Box {
    static fromBounds(bounds, id, depthBegin, depthEnd, parent) {
        return new Box(
            bounds[0], bounds[1], bounds[2],
            bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2],
            id, depthBegin, depthEnd, parent);
    }

    constructor(x, y, z, w, h, d, id, depthBegin, depthEnd, parent) {
        this.x = x; this.y = y; this.w = w, this.h = h;
        this.z = z; this.d = d;

        this.id = id || "R";
        this.depthBegin = depthBegin;
        this.depthEnd = depthEnd;
        this.parent = parent;

        // stuff to determine sphere visibility
        this.radius = Math.sqrt(w * w + h * h + d * d) / 2;
        this.position = [x + w / 2, y + h / 2, z + d / 2];
    }

    _split() {
        const x = b.x, y = b.y, z = b.z;
        const w = b.w, h = b.h, d = b.d;

        let boxes = [];

        const childrenDepthBegin = (this.depthBegin === 0) ? this.depthEnd : (this.depthBegin + 1),
              childrenDepthEnd = b.depthEnd + 1;

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
                this));
        }

        return boxes;
    }

    geoAndWorldBounds(geoOrigin) {
        const node = this;
        const x = node.x + geoOrigin[0],
              y = node.y + geoOrigin[1],
              z = node.z + geoOrigin[2];

        const geoBounds = [x, y, z, x + node.w, y + node.h, z + node.d];
        const worldBounds = [node.x, node.y, node.z, node.x + node.w, node.y + node.h, node.z + node.d];

        return {
            geoBounds: geoBounds,
            worldBounds: worldBounds
        };
    }

    subdivide (stopSplitDepth, hardStopDepth) {
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
        if (depth < stopSplitDepth) {
            // regular split, no need to do anything special, just split 8 ways
            boxes = _split();
        }
        else if (depth === stopSplitDepth) {
            // bulk load to load all levels to full depth
            boxes = [
                new Box(x, y, z, w, h, d, this.id + "" + 0,
                    this.depthBegin + 1, hardStopDepth, this)
            ];
        }

        return boxes;
    }

    intersects(f, offset) {
        offset = offset || [0, 0, 0];

        let x = this.x + offset[0],
            y = this.y + offset[1],
            z = this.z + offset[2];

        var mins = [x, y, z, 1],
            maxs = [x + box.w, y + box.h, z + box.d, 1];

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


export class FrustumLODNodePolicy extends EventEmitter {
    constructor(namespace, loaders, renderer, params) {
        super();

        this.namespace = namespace;
        this.renderer = renderer;
        this.loaders = loaders;

        this.geoBounds = util.checkParam(params, 'geoBounds');
        this.geoTreeOrigin = util.boundsCenter(this.geoBounds);

        this.baseDepth = params.baseDepth || 8;
        this.renderTreeOffset = params.offset || [0, 0, 0];

        // find the point loader, we need this to pre-query certain things
        this.pointLoader = loaders.find(e => e.constructor.provides === "point-buffer");
        if (!this.pointLoader)
            throw new Error("No point loader specified.  A point loader needs to be available in the list of loaders");

        // create a tree info cache
        this.treeInfoCache = new TreeInfoCache(this.pointLoader, this.geoBounds, this.baseDepth, this.geoTreeOrigin);

        // add in our loaders, namespaced!
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

        console.log("FrustumLODNodePolicy initialized with point cloud space bbox:", this.bbox, "normalize?", "always");
    }

    stop() {
        this.renderer.removePropertyListener(this.propListener);
        this.renderer.removePropertyListener(this.cameraPropsListener);
    }

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

    _makeId(node) {
        // make sure the points are in a valid coordinate system, offset them
        // by the center
        let {geoBounds, worldBounds} = this._nodeGeoAndWorldBounds(node);

        const queryParams = {
            geoBounds: geoBounds,
            worldBounds: worldBounds,
            fullGeoBounds: this.geoBounds,
            depthBegin: node.depthBegin,
            depthEnd: node.depthEnd,
        };

        let id = {};
        l.forEach(e => {
            id[o.namespace + "/" + e.constructor.key] = e.queryFor(queryParams);
        });

        return id;
    }

    _nodeGeoAndWorldBounds(node) {
        return node.geoAndWorldBounds(this.geoTreeOrigin);
    }

    static _screenSizeForBox(box, cameraFOV, eyeToBoxDistance, clientHeight) {
        let fov = cameraFOV / 2 * Math.PI / 180.0;
        let pr = 1 / Math.tan(fov) * box.radius / Math.sqrt(eyeToBoxDistance * eyeToBoxDistance -
                box.radius * box.radius);

        return [pr, clientHeight * pr];
    }

    static _figureAspect() {
        const width = window.innerWidth,
              height = window.innerHeight,
              aspect = (width > height) ? width / height : height / width;

        return [width, height, aspect];
    }

    async _loadNode (node) {
        let {geoBounds, worldBounds} = this._nodeGeoAndWorldBounds(node);

        let queryParams = {
            geoBounds: geoBounds,
            worldBounds: worldBounds,
            fullGeoBounds: this.geoBounds,
            depthBegin: node.depthBegin,
            depthEnd: node.depthEnd
        };

        let params = o.pointLoader.queryFor(queryParams);
        return await o.pointLoader.constructor.load(params);
    };

    async _loadRootNode() {
        const baseBox = new Box(bbox[0], bbox[1], bbox[2],
            bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2],
            "R", 0, this.baseDepth, null);

        console.log("trying to load root node", baseBox);
        return await loadNode(baseBox);
    }

    async start() {
        // first things first, download the meta information file and see what
        // we're dealing with
        const geoBounds = this.geoBounds;

        // although we have bounding box here provided to us by the user, we should
        // always simulate this as an async thing, since certain policies will
        // probably fetch it from the server.
        setTimeout(function() {
            o.emit("bbox", bb);
        });

        var startDepth = this.baseDepth;

        o.nodes = [];
        const rootNodeData = await this._loadRootNode();
        this.updateTrigger = new TriggeredDispatch(500, (view) => this._updateView(view));
    }

    async _updateView(view) {
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

        let [clientWidth, clientHeight, aspect] = this._figureAspect();

        const baseBox = Box.fromBounds(this.worldBounds, "R", 0,
            this.baseDepth, null);

        console.log("-- -- Frustum Basebox:", baseBox);

        // Figure our current projection and view matrices
        const proj = mat4.perspective(mat4.create(), fov * Math.PI / 180.0, aspect, near, far);
        const viewMatrix = mat4.lookAt(mat4.create(), eye, target, [0, 1, 0]);

        // Update our frustum for new view
        this.frustum.update(proj, viewMatrix);

        // nodes will collect all nodes that we will need to process
        // this frame as we walk down the tree, a node will be picked
        // from the front of this array and new child nodes will be pushed
        // to the back
        let nodes = [{node: baseBox, weight: 0}];
        var visible = [];

        // A temporary vector we need to store current node's position
        let nodePosition = vec3.create();

        console.time("collectNodes");
        while (nodes.length > 0) {
            // pick the node in the front of the list
            const thisNode = nodes.shift();
            const node = thisNode.node;

            // is this node visible? if not we bail on this branch
            // rightaway
            if (!node.intersectsFrustum(frustum))
                continue;

            // figure out certain things we need
            let cameraToBoxDistance = vec3.distance(eye, vec3.add(nodePosition, node.position, this.renderTreeOffset));
            let [vf, radiusOnScreen] = this._screenSizeForBox(node, fov,
                cameraToBoxDistance, clientHeight);

            // if too small, discard
            if (radiusOnScreen < FrustumLODNodePolicy.REJECT_ON_SCREEN_SIZE_RADIUS) {
                continue;
            }

            node.weight = thisNode.weight;
            visible.push(node);

            // determine children worthy of inheriting the lineage
            const children = node.subdivide();

            if (children.length === 1) {
                // this is end of traversal since we're going to make a parallel
                // query to get all buffers under this and add it in one go
                //
                visible.push(children[0]);
            }
            else {
                // do regular traversal
                for (var i = 0, il = children.length; i < il; i++) {
                    const child = children[i];

                    // determine weight for this node
                    let cameraToChildDistance =
                        vec3.distance(eye, vec3.add(nodePosition, child.position, o.treeOffset));
                    let [_, childRadiusOnScreen] =
                        this._screenSizeForBox(child, fov, cameraToChildDistance, clientHeight);

                    let weight = 1 / cameraToChildDistance;

                    if (childRadiusOnScreen < FrustumLODNodePolicy.REJECT_ON_SCREEN_SIZE_RADIUS) {
                        continue;
                    }

                    // find the right spot for this node inside the nodes stack
                    if (nodes.length === 0) {
                        nodes.push({node: child, weight: weight});
                    }
                    else {
                        var index = -1;
                        for (var j = 0, jl = nodes.length; j < jl; j++) {
                            if (nodes[j].weight < weight) {
                                index = j;
                                break;
                            }
                        }

                        if (index !== -1)
                            nodes.splice(index, 0, {node: child, weight: weight});
                        else
                            nodes.push({node: child, weight: weight});
                    }
                }
            }
        }
        console.timeEnd("collectNodes");

        // turn the linear list into a hierarchy
        console.time("collate");
        visible.forEach(n => {
            if (n.parent) {
                let children = n.parent.wc || [];
                children.push(n);
                n.parent.wc = children;
            }
        });
        console.timeEnd("collate");

        // make sure that only new buffers are loaded in right
        //
        let diff = (a, b) => {
            return _.filter(a, function (n) {
                return !_.find(b, _b => _b.id === n.id);
            });
        };

        var common = (a, b) => {
            return _.filter(a, function (n) {
                return _.find(b, _b => _b.id === n.id);
            });
        };

        const newNodes = diff(visible, this.nodes);
        const commonNodes = common(visible, this.nodes);
        if (lastLoader) {
            lastLoader.abort();
            lastLoader = null;
        }

        let loader = new Preloader(o.treeInfoCache, this.geoTreeOrigin);
        lastLoader = loader;

        let root = visible[0];

        visible = [];
        console.log("starting walk", visible.length);
        console.log("nodes already in scene:", o.nodes);

        await loader.walkTree(root, rootNodeData, n => {
            // this is the node which needs to go into the renderer
            visible.push(n);

            // make sure we update our nodes with this newly added node so that
            // next frame we can remove it
            if (_.findIndex(o.nodes, 'id', n.id) === -1) {
                o.nodes.push(n);

                // since we don't want to wait for the whole tree traversal to happen before loading buffers
                // we add visible buffers right away
                o.renderer.addPointBuffer(makeId(n));
            }
        });

        console.log("walk done!", we, "clearing up going away nodes.");

        const nodesToRemove = diff(o.nodes, visible);
        console.log("nodes to remove:", nodesToRemove);

        nodesToRemove.forEach(n => this.renderer.removePointBuffer(makeId(n)));
        this.nodes = visible;

        this.emit("view-changed", {
            eye: eye, target: target
        });

        this.simulateVal = () => {
            this.trigger.simulateVal();
        };

        this.clearAll = () => {
            this.nodes.forEach(this.nodes, n => this.renderer.removePointBuffer(makeId(n)));
        };

        this.abortLoad = () => {
            if (this.lastLoader) {
                this.lastLoader.abort();
                this.lastLoader = null;
            }
        };

        // make sure view properties are triggered through our trigger mechanism
        this.propListener = this.renderer.addPropertyListener(["view"], (view) => this.trigger.val(view));
    }
}



FrustumLODNodePolicy.REJECT_ON_SCREEN_SIZE_RADIUS = 300;
FrustumLODNodePolicy.STOP_SPLIT_DEPTH = 16;
FrustumLODNodePolicy.HARD_STOP_DEPTH = 32;
FrustumLODNodePolicy.TREE_PREFETCH_STEP = 6;



class Preloader {
    constructor(cache, center) {
        this.cache = cache;
        this.nodesToLoad = [];
        this.center = center;
        this.aborted = false;
        this.q = null;
    }

    abort() {
        this.aborted = true;
        if (this.q) {
            console.log("ABORTING!");
            this.q.kill();
            this.q = null;
        }
    }

    async walkTree(baseNode, baseNodeData, cb) {
        const center = this.center;
        const {geoBounds, worldBound} = baseNode.geoAndWorldBounds(center);

        return new Promise((resolve, reject) => {
            let q = async.queue((node, done1) => {
                o.cache.nodeInfo(node, (n) => {
                    // if this response gives us an error or zero points no point going down this tree, also if this node is
                    // root node, the count is the sume of points from 0->8 taken from rootNodeData and not the count returned here
                    //
                    if (node.id === "R")
                        n = baseNodeData.totalPoints;

                    if (n > 0 && !o.aborted) {
                        cb(node);
                        if (node.wc && node.wc.length > 0) {
                            node.wc.forEach(n => o.q.push(n));
                        }
                    }
                    done1();
                });
            }, 8);

            q.drain = done;
            q.push(baseNode);
            o.q = q;
        });
    }
}


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
