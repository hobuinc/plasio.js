// greyhound-lod.js
// Greyhound data fetch as a quadtree
//

var gh = require("greyhound.js"),
    EventEmitter = require("events").EventEmitter,
    vec3 = require("gl-matrix").vec3,
    vec4 = require("gl-matrix").vec4,
    vec2 = require("gl-matrix").vec2,
	mat4 = require("gl-matrix").mat4,
    LRU = require("lru-cache"),
    inherits = require('util').inherits,
    createHash = require('sha.js'),
    _ = require("lodash"),
    async = require("async"),
    util = require("./util"),
    TriggeredDispatch = util.TriggeredDispatch;

class TreeInfoCache {
    constructor(loader, fullBBox, baseDepth, center) {
        this.loader = loader;
        this.center = center;
        this.baseDepth = baseDepth;
        this.nodesCache = {};

        this.rangeX = [fullBBox.mins[0], fullBBox.maxs[0]];
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
            "neu": 6, "nwu": 7,
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

    nodeInfo(node, cb) {
        let k = this.__key(node);
        let info = this.nodesCache[k];
        let stepSize = FrustumLODNodePolicy.TREE_PREFETCH_STEP;
        let stopSplitDepth = FrustumLODNodePolicy.STOP_SPLIT_DEPTH;

        if (info == null) {
            // we don't know about this node yet, is it a pre-fetch node?
            if (this.__isPrefetchLevel(node) &&
                node.depthEnd < stopSplitDepth) {
                // yes its a pre-fetch level, so query it and load stuff up
                let x = node.x + this.center[0],
                    y = node.y + this.center[1],
                    z = node.z + this.center[2];
                let bbox = new gh.BBox([x, y, z],
                                       [x + node.w, y + node.h, z + node.d]);

                console.log("TREE: PREFETCH! ", node.id, node.depthEnd, "->", node.depthEnd + stepSize);

                this.loader.loadHierarchyInfo(bbox, this.rangeX, node.depthEnd, node.depthEnd + stepSize, (err, res) => {
                    let r = res || {n: 0};

                    this.__store(k, r.n);
                    this.__loadInfo(node, r);

                    cb(r.n);
                });
            }
            else {
                cb(0);
            }
        }
        else {
            cb(info);
        }
    }
}

var FrustumLODNodePolicy = function(namespace, loaders, renderer, params) {
    if (!params.pointCloudBBox) {
        throw new Error("No point cloud bounding box has been specified in params.");
    }

    this.namespace = namespace;
    this.renderer = renderer;
    this.bbox = params.pointCloudBBox;
    this.normalize = !!params.normalize;
    this.loaders = loaders;
    this.baseDepth = 8;
    this.treeOffset = params.offset || [0, 0, 0];

    this.pointLoader = loaders.find(e => {
        return e.constructor.provides === "point-buffer";
    });

    if (!this.pointLoader)
        throw new Error("No point loader specified.  A point loader needs to be available in the list of loaders");

    var b = this.bbox.slice();
    var bb = new gh.BBox(b.slice(0, 3),
                         b.slice(3, 6));
    this.treeInfoCache = new TreeInfoCache(this.pointLoader, bb, this.baseDepth, bb.center());

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

    console.log("FrustumLODNodePolicy initialized with point cloud space bbox:", this.bbox, "normalize?", this.normalize);
    this.debug = {};
};


FrustumLODNodePolicy.REJECT_ON_SCREEN_SIZE_RADIUS = 300;
FrustumLODNodePolicy.STOP_SPLIT_DEPTH = 16;
FrustumLODNodePolicy.HARD_STOP_DEPTH = 32;
FrustumLODNodePolicy.TREE_PREFETCH_STEP = 6;


var Box = function(x, y, z, w, h, d, id, depthBegin, depthEnd, parent) {
    this.x = x; this.y = y ; this.w = w, this.h = h;
    this.z = z; this.d = d;

    this.id = id || "R";
    this.depthBegin = depthBegin;
    this.depthEnd = depthEnd;
    this.parent = parent;

    // stuff to determine sphere visibility
    this.radius = Math.sqrt(w * w + h * h + d * d) / 2;
    this.position = [x + w/2, y + h/2, z + d/2];
};

// Turn this to false for experimental stuffs
Box.forceQuad = false;


var _idgen = function* (baseid) {
    var index = 0;
    while (true) {
        yield baseid + index;
        index ++;
    }
};

var _split = function(gen, b) {
    // when splitting using this mechanism, the depthBegin and depthEnd are just
    // incremented
    var id = () => gen.next().value;

    let x = b.x, y = b.y, z = b.z;
    let w = b.w, h = b.h, d = b.d;

    let boxes = [];

    let depthBegin = (b.depthBegin === 0) ? b.depthEnd : (b.depthBegin + 1),
        depthEnd = b.depthEnd + 1;

    for (var i = 0 ; i < 8 ; i++) {
        let e = i & 1;
        let f = (i >> 1) & 1;
        let g = (i >> 2) & 1;

        boxes.push(new Box(
            x + (e ? (w / 2) : 0),
            y + (f ? (h / 2) : 0),
            z + (g ? (d / 2) : 0),
            w/2, h/2, d/2, id(),
            depthBegin,
            depthEnd,
            b));
    }

    return boxes;
};

Box.prototype.subdivide = function() {
    // subdivision rules:
    //
    // Is my depth past the hard limit? No subdivision.
    // Is my depth past the stop split depth? Only one child, exactly the same bounds as me, only a depth lower.
    // Am I configured for hierarchy load? Mark load as hierarchy load and children are all the children of depthToShow level.
    // For everything else, subdivide normally.
    //
    var x = this.x, y = this.y, z = this.z;
    var w = this.w, h = this.h, d = this.d;

    var genid = _idgen(this.id);
    var id = () => genid.next().value;

    var depth = this.depthBegin + 1;

    var boxes = [];
    if (depth < FrustumLODNodePolicy.STOP_SPLIT_DEPTH) {
        // regular split, no need to do anything special, just split 8 ways
        boxes = _split(genid, this);
    }
    else if (depth === FrustumLODNodePolicy.STOP_SPLIT_DEPTH) {
        // bulk load to load all levels to full depth
        boxes = [
            new Box(x, y, z, w, h, d, id(), this.depthBegin + 1, FrustumLODNodePolicy.HARD_STOP_DEPTH, this)
        ];
    }

    return boxes;
};

class Preloader {
    constructor(cache, center, normalize) {
        this.cache = cache;
        this.nodesToLoad = [];
        this.center = center;
        this.aborted = false;
        this.normalize = normalize;
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

    walkTree(baseNode, baseNodeData, cb, done) {
        let o = this;
        let center = o.center;
        let fullPointBBox = new gh.BBox([
            center[0] + baseNode.x,
            center[1] + baseNode.y,
            center[2] + baseNode.z
        ], [
            center[0] + baseNode.x + baseNode.w,
            center[1] + baseNode.y + baseNode.h,
            center[2] + baseNode.z + baseNode.d
        ]);

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
    }
}


var ppoint = function(data, idx) {
    var f = new Float32Array(data.buffer);
    var off = idx * 8;
    console.log("x:", f[0], "y:", f[1], "z:", f[2],
                "r:", f[3], "g:", f[4], "b:", f[5],
                "i:", f[6], "c:", f[7]);
};

inherits(FrustumLODNodePolicy, EventEmitter);

FrustumLODNodePolicy.prototype.stop = function() {
    this.renderer.removePropertyListener(this.propListener);
    this.renderer.removePropertyListener(this.cameraPropsListener);
};

FrustumLODNodePolicy.prototype.hookedReload = function(f) {
    if (this.abortLoad)
        this.abortLoad();

    if (this.clearAll)
        this.clearAll();

    this.nodes = [];

    if (f) f.call(null);

    if (this.simulateVal)
        this.simulateVal();
};

FrustumLODNodePolicy.prototype._hookupDebug = function() {
};


// given a view matrix, figure out the planes in view space, puts
// the extracted planes in planes
var frustumPlanes = (function() {
    var frustumMat = mat4.create();

    var m = function(r, c) {
        return frustumMat[(c -1) * 4 + (r - 1)];
    };

	var norm = function(p) {
		var f = vec3.length(p);

		p[0] /= f;
		p[1] /= f;
		p[2] /= f;
		p[3] /= f;
	};

	return function(proj, view) {
	    var frustum = [
            vec4.create(),
            vec4.create(),
            vec4.create(),
            vec4.create(),
            vec4.create(),
            vec4.create()
        ];

        mat4.multiply(frustumMat, proj, view);


        vec4.set(frustum[0], m(4, 1) + m(1,1), m(4, 2) + m(1, 2), m(4, 3) + m(1, 3), m(4,4) + m(1,4));
        vec4.set(frustum[1], m(4, 1) - m(1,1), m(4, 2) - m(1, 2), m(4, 3) - m(1, 3), m(4,4) - m(1,4));

        vec4.set(frustum[2], m(4, 1) + m(2,1), m(4, 2) + m(2, 2), m(4, 3) + m(2, 3), m(4,4) + m(2,4));
        vec4.set(frustum[3], m(4, 1) - m(2,1), m(4, 2) - m(2, 2), m(4, 3) - m(2, 3), m(4,4) - m(2,4));

        vec4.set(frustum[4], m(4, 1) + m(3,1), m(4, 2) + m(3, 2), m(4, 3) + m(3, 3), m(4,4) + m(3,4));
        vec4.set(frustum[5], m(4, 1) - m(3,1), m(4, 2) - m(3, 2), m(4, 3) - m(3, 3), m(4,4) - m(3,4));

		frustum.forEach(norm);
		return frustum;
	};
})();


// Given the 6 frustum planes, a bbox and a viewMatrix, this function figures if the
// box intersects the bbox
//
function intersectFrustum(frustum, box, offset) {
    let o = offset || [0, 0, 0];
    let x = box.x + o[0],
        y = box.y + o[1],
        z = box.z + o[2];
    
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
};

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


FrustumLODNodePolicy.prototype.start = function() {
    var o = this;

    // first things first, download the meta information file and see what
    // we're dealing with
    var bbox = o.bbox.slice();
    var bb = new gh.BBox(bbox.slice(0, 3),
                         bbox.slice(3, 6));

    // although we have bounding box here provided to us by the user, we should
    // always simulate this as an async thing, since certain policies will
    // probably fetch it from the server.
    setTimeout(function() {
        o.emit("bbox", bb);
    });

    var center = bb.center();
    var startDepth = this.baseDepth;

    o.nodes = [];

    // make sure our bounding box is offset correct by the center of the volume
    bbox[0] -= center[0];
    bbox[1] -= center[1];
    bbox[2] -= center[2];
    bbox[3] -= center[0];
    bbox[4] -= center[1];
    bbox[5] -= center[2];

    var l = o.loaders;
    var makeId = function(node) {
        var id = {};

        // make sure the points are in a valid coordinate system, offset them
        // by the center
        var x = node.x + center[0],
            y = node.y + center[1],
            z = node.z + center[2];

        var bbox = new gh.BBox([x, y, z],
                               [x + node.w, y + node.h, z + node.d]);

        var worldBBox = bbox.offsetBy(center);

        var queryParams = {
            worldBBox: worldBBox,
            pointCloudBBox: bbox,
            fullPointCloudBBox: bb,
            depthBegin: node.depthBegin,
            depthEnd: node.depthEnd,
            normalize: o.normalize,
            adjustmentOffset: o.treeOffset
        };

        l.forEach(e => {
            id[o.namespace + "/" + e.constructor.key] = e.queryFor(queryParams);
        });

        return id;
    };

    var screenSizeForBox = function(box, cameraFOV, eyeToBoxDistance, clientHeight) {
        let fov = cameraFOV / 2 * Math.PI / 180.0;
        let pr = 1 / Math.tan(fov) * box.radius / Math.sqrt(eyeToBoxDistance * eyeToBoxDistance -
                box.radius * box.radius);

        return [pr, clientHeight * pr];
    };

    var figureAspect = function() {
        let width = window.innerWidth,
            height = window.innerHeight,
            aspect = (width > height) ? width / height : height / width;

        return [width, height, aspect];
    };

    let loadNode = function(node, cb) {
        let x = node.x + center[0],
            y = node.y + center[1],
            z = node.z + center[2];

        let bbox = new gh.BBox([x, y, z],
                               [x + node.w, y + node.h, z + node.d]);
        let worldBBox = new gh.BBox([node.x, node.y, node.z],
                                    [node.x + node.w, node.y + node.h, node.z + node.d]);

        let queryParams = {
            pointCloudBBox: bbox,
            fullPointCloudBBox: bb,
            worldBBox: worldBBox,
            depthBegin: node.depthBegin,
            depthEnd: node.depthEnd,
            normalize: o.normalize
        };

        let params = o.pointLoader.queryFor(queryParams);
        o.pointLoader.constructor.load(params, cb);
    };

    let loadRootNode = function(cb) {
        var baseBox = new Box(
            bbox[0], bbox[1], bbox[2],
            bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2],
            "R", 0, startDepth, null);
        loadNode(baseBox, cb);
    };

    loadRootNode(function(err, rootNodeData) {
        var lastLoader = null;
        var trigger = new TriggeredDispatch(500, function(view) {
            if (!view)
                return;

            // figure out view and target position
            //
            var eye = view.eye;
            var target = view.target;
            var cameras = view.cameras;

            if (eye === null || target === null || cameras == null)
                return;

            // first find the active camera
            var camera = _.find(cameras, 'active');
            if (!camera)
                return;

            if (camera.type !== "perspective") {
                console.log(
                    "FrustumLODNodePolicy only supports perspective cameras " +
                        "for now");
                return;
            }

            // setup current projection and view matrices
            let near = camera.near || 0.01;
            let far = camera.far || 1000.0;
            let fov = camera.fov || 75;

            let [clientWidth, clientHeight, aspect] = figureAspect();


            // The bounds of all the things
            //
            var baseBox = new Box(
                bbox[0], bbox[1], bbox[2],
                bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2],
                "R", 0, startDepth, null);

            console.log("-- -- baseBox:", baseBox);

            // o.treeInfoCache.nodeInfo(baseBox, v => console.log("TREE:", v));


            var proj = mat4.perspective(mat4.create(), fov * Math.PI / 180.0, aspect, near, far);
            var viewMatrix = mat4.lookAt(mat4.create(), eye, target, [0, 1, 0]);
            var frustum = frustumPlanes(proj, viewMatrix);

            // keep it flat
            var nodes = [{node: baseBox, weight: 0}];
            var visible = [];

            var nodePosition = vec3.create();

            console.time("collectNodes");
            while(nodes.length > 0) {
                let thisNode = nodes.shift();
                let node = thisNode.node;

                // can we see it?
                let inview = intersectFrustum(frustum, node, o.treeOffset);
                if (!inview) continue;

                // figure out certain things we need
                let cameraToBoxDistance = vec3.distance(eye, vec3.add(nodePosition, node.position, o.treeOffset));
                let [vf, radiusOnScreen] = screenSizeForBox(node, fov, cameraToBoxDistance, clientHeight);

                // if too small, discard
                if (radiusOnScreen < FrustumLODNodePolicy.REJECT_ON_SCREEN_SIZE_RADIUS) {
                    continue;
                }

                node.weight = thisNode.weight;
                visible.push(node);

                // determine children worthy of inheriting the lineage
                let children = node.subdivide();

                if (children.length === 1) {
                    // this is end of traversal since we're going to make a parallel
                    // query to get all buffers under this and add it in one go
                    //
                    visible.push(children[0]);
                }
                else {
                    // do regular traversal
                    for (var i = 0, il = children.length; i < il; i++) {
                        var child = children[i];

                        // determine weight for this node
                        let cameraToChildDistance = vec3.distance(eye, vec3.add(nodePosition, child.position, o.treeOffset));
                        let [_, childRadiusOnScreen] = screenSizeForBox(child, fov, cameraToChildDistance, clientHeight);

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
            var diff = function(a, b) {
                return _.filter(a, function(n) { return !_.find(b, _b => _b.id === n.id); });
            };

            var common = function(a, b) {
                return _.filter(a, function(n) { return _.find(b, _b => _b.id === n.id);});
            };

            var newNodes = diff(visible, o.nodes);
            var commonNodes = common(visible, o.nodes);
            var nodesToRemove = diff(o.nodes, visible);

            if (lastLoader) {
                lastLoader.abort();
                lastLoader = null;
            }

            let loader = new Preloader(o.treeInfoCache, center, o.normalize);
            lastLoader = loader;

            let root = visible[0];

            visible = [];
            console.log("starting walk", visible.length);
            console.log("nodes already in scene:", o.nodes);

            let walkStart = util.perf_start();
            loader.walkTree(root, rootNodeData, n => {
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
            }, () => {
                let we = util.perf_end(walkStart);
                console.log("walk done!", we, "clearing up going away nodes.");

                var nodesToRemove = diff(o.nodes, visible);
                console.log("nodes to remove:", nodesToRemove);
                _.forEach(nodesToRemove, function(n) {
                    o.renderer.removePointBuffer(makeId(n));
                });

                o.nodes = visible;
            });

            o.emit("view-changed", {
                eye: eye, target: target
            });

            o.simulateVal = function() {
                trigger.simulateVal();
            };

            o.clearAll = function() {
                _.forEach(o.nodes, function(n) {
                    o.renderer.removePointBuffer(makeId(n));
                });
            };

            o.abortLoad = function() {
                if (lastLoader) {
                    lastLoader.abort();
                    lastLoader = null;
                }
            }
        });

        // make sure view properties are triggered through our trigger mechanism
        o.propListener = o.renderer.addPropertyListener(["view"], function(view) {
            trigger.val(view);
        });
    });


    return o.propListener;
};


class MultiPolicyContainer extends EventEmitter {
    constructor(policies) {
        super();
        this.policies = policies;
    }

    start() {
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

        this.policies.forEach((p) => {
            wrapEvents(p);
            p.start();
        });
    }
}


module.exports = {
    FrustumLODNodePolicy: FrustumLODNodePolicy,
    MultiPolicyContainer: MultiPolicyContainer
};
