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

var Box = function(x, y, z, w, h, d, id, depth, parent) {
	this.x = x; this.y = y ; this.w = w, this.h = h;
	this.z = z; this.d = d;

	this.id = id || "R";
	this.depth = depth || 0;
    this.parent = parent;
    this.visibleDepth = this.depth;

    // stuff to determine sphere visibility
    this.radius = Math.sqrt(w * w + h * h + d * d) / 2;
    this.position = [x + w/2, y + h/2, z + d/2];
};

// Turn this to false for experimental stuffs
Box.forceQuad = false;


Box.prototype.setRootVisibilityHint = function(depthToShow) {
    this.visibleDepth = depthToShow;
};

var _idgen = function* (baseid) {
    var index = 0;
    while (true) {
        yield baseid + index;
        index ++;
    }
};

var _split = function(gen, b) {
    var id = () => gen.next().value;

    let x = b.x, y = b.y, z = b.z;
    let w = b.w, h = b.h, d = b.d;
    let depth = b.depth + 1;

    let boxes = [];

    for (var i = 0 ; i < 8 ; i++) {
        let e = i & 1;
        let f = (i >> 1) & 1;
        let g = (i >> 2) & 1;

        boxes.push(new Box(
            x + (e ? (w / 2) : 0),
            y + (f ? (h / 2) : 0),
            z + (g ? (d / 2) : 0),
            w/2, h/2, d/2, id(), depth, b));
    }

    return boxes;
};

var bulkSplitBoxToLevel = function(box, toLevel) {
    let gen = _idgen(box.id);

    let loop = function(b, arr) {
        let r = [b.x, b.y, b.z, b.w, b.h, b.d, b.depth];
        arr.push(r);

        let depth = b.depth + 1;

        if (depth > toLevel)
            return;

        var c = _split(gen, b);
        c.forEach(n => loop(n, arr));
    };

    let res = [];
    loop(box, res);
    return res;
};

var bulkWalkToLevel = function(box, toLevel) {
    var x = box.x, y = box.y, z = box.z;
    var w = box.w, h = box.h, d = box.d;

    var depth = box.depth;

    let res = [];
    for (var i = depth ; i < toLevel ; i ++) {
        res.push([x, y, z, w, h, d, i]);
    }

    return res;
};

Box.prototype.subdivide = function(zeroReturn) {
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

    var STOP_SPLIT_DEPTH = 9;
    var HARD_STOP_DEPTH = 20;

    var depth = this.depth + 1;

    var boxes = [];
    if (this.visibleDepth && this.visibleDepth > this.depth) {
        // bulk load to load the first view levels and make them part of a single buffer
        // split 8 ways till we hit our limit
        //
        this.bulk = bulkSplitBoxToLevel(this, this.visibleDepth);
        boxes = this.bulk.
            filter(n => n[6] === this.visibleDepth).
            map(([x, y, z, w, h, d, depth]) => new Box(x, y, z, w, h, d, id(), depth, this));

    }
    else if (depth < STOP_SPLIT_DEPTH) {
        // regular split, no need to do anything special, just split 8 ways
        boxes = _split(genid, this);
    }
    else if (depth === STOP_SPLIT_DEPTH) {
        // bulk load to load all levels to full depth
        boxes = [
            new Box(x, y, z, w, h, d, id(), depth, this)
        ];

        boxes[0].bulk = bulkWalkToLevel(boxes[0], HARD_STOP_DEPTH);
    }

    return boxes;
};

var zeroReturn = null;


var raf = window.requestAnimationFrame ||
        window.webkitRequestAnimationFrame ||
        window.mozRequestAnimationFrame ||
        window.msRequestAnimationFrame ||
        setTimeout;

// takes a bulk array with bounds and depth and then applies start depth to it
// in a way that we end up with 8 elements per result with start and end depths defined
//
var bulkCollate = function(bulk, startDepth, center) {
    let b = bulk.map(a => {
        let end = startDepth + a[6],
            start = (end === startDepth) ? 0 : (end - 1);

        let r = _(a).
            dropRight(1).
            concat(start, end).
            value();

        r[0] += center[0];
        r[1] += center[1];
        r[2] += center[2];

        r[3] += r[0];
        r[4] += r[1];
        r[5] += r[2];

        return r;
    });

    return b;
};

class Preloader {
    constructor(loader, center, startDepth) {
        this.loader = loader;
        this.nodesToLoad = [];
        this.center = center;
        this.startDepth = startDepth;
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

    walkTree(baseNode, cb, done) {
        let o = this;
        let center = o.center;
        let q = async.queue((node, done1) => {
            let x = node.x + center[0],
                y = node.y + center[1],
                z = node.z + center[2];

            let bbox = new gh.BBox([x, y, z],
                [x + node.w, y + node.h, z + node.d]);

            let depthEnd = o.startDepth + node.depth;
            let depthBegin = (depthEnd === o.startDepth) ? 0 : (depthEnd - 1);

            let bulk = _.isArray(node.bulk) ? bulkCollate(node.bulk, o.startDepth, center) : null;

            let params = o.loader.queryFor(bbox, depthBegin, depthEnd, bulk);
            o.loader.constructor.load(params, (err, data) => {
                // if this response gives us an error or zero points no point going down this tree
                if (!err && data.totalPoints > 0 && !o.aborted) {
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

var FrustumLODNodePolicy = function(
        loaders,
        renderer,
        bbox,
        closestPlaneDistance,
        maxDepth,
        imagerySource) {

    if (!loaders.point || !loaders.transform)
        throw new Error(
                "The loaders need to have point buffer and transform loaders");

    this.renderer = renderer;
    this.bbox = bbox;
	this.loaders = loaders;
	this.maxDepth = (maxDepth || 19) + 1;
	this.closestPlaneDistance = (closestPlaneDistance || 50);
	this.maxDepthReduction = 0;
    this.imagerySource = imagerySource;


    // determine zero return stuff
    //
    if (loaders.point &&
        loaders.point.constructor &&
        loaders.point.constructor.zeroReturn) {
        var zf = loaders.point.constructor.zeroReturn;
        
        var bb = new gh.BBox(bbox.slice(0, 3),
                             bbox.slice(3, 6));

        var center = bb.center();

        zeroReturn = function(xs, ys, zs, xe, ye, ze) {
            return zf(xs + center[0], ys + center[1], zs + center[2],
               xe + center[0], ye + center[1], ze + center[2]);
        };
    }

	this.debug = {};
};

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

FrustumLODNodePolicy.prototype.setImagerySource = function(imagerySource) {
    if (this.clearAll)
        this.clearAll();

    this.imagerySource = imagerySource;
    this.nodes = [];

    if (this.simulateVal)
        this.simulateVal();
};

FrustumLODNodePolicy.prototype._hookupDebug = function() {
};


FrustumLODNodePolicy.prototype.setDistanceHint = function(hint) {
	this.closestPlaneDistance = hint;
	if (this.simulateVal)
		this.simulateVal();
};


FrustumLODNodePolicy.prototype.setMaxDepthReductionHint = function(maxDepthReduction) {
	this.maxDepthReduction = maxDepthReduction;
	if (this.simulateVal)
		this.simulateVal();
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
function intersectFrustum(frustum, box) {
	var mins = [box.x, box.y, box.z, 1],
        maxs = [box.x + box.w, box.y + box.h, box.z + box.d, 1];

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
	var startDepth = this.baseDepth || 6;
    var baseDepthToDisplay = Math.max(startDepth, 8);

	o.renderer.setRenderOptions({xyzScale: [1, 1, 1]});
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
        let depthEnd = startDepth + node.depth,
            depthBegin = (depthEnd === startDepth) ? 0 : (depthEnd - 1),
            bulk = _.isArray(node.bulk) ? bulkCollate(node.bulk, startDepth, center) : null;


	    if (l.point) {
            id[l.point.constructor.key] =
                l.point.queryFor(bbox, depthBegin, depthEnd, bulk);
        }

	    if (l.overlay) {
            id[l.overlay.constructor.key] =
                l.overlay.queryFor(bbox, o.imagerySource);
        }

	    if (l.transform) {
            id[l.transform.constructor.key] =
                l.transform.queryFor(worldBBox, bbox);
        }

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
        var baseBox = new Box(bbox[0], bbox[1], bbox[2],
            bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]);

        baseBox.setRootVisibilityHint(baseDepthToDisplay - startDepth);

        var proj = mat4.perspective(mat4.create(), fov * Math.PI / 180.0, aspect, near, far);
        var viewMatrix = mat4.lookAt(mat4.create(), eye, target, [0, 1, 0]);
        var frustum = frustumPlanes(proj, viewMatrix);
        var midY = baseBox.y + baseBox.w / 2;

        // keep it flat
        var nodes = [{node: baseBox, weight: 0}];
        var visible = [];

        var tt = util.perf_start();
        while(nodes.length > 0) {
            // can we see it?
            let thisNode = nodes.shift();
            let node = thisNode.node;

            let inview = intersectFrustum(frustum, node);

            if (!inview) continue;


            // figure out certain things we need
            let cameraToBoxDistance = vec3.distance(eye, node.position);
            let [vf, radiusOnScreen] = screenSizeForBox(node, fov, cameraToBoxDistance, clientHeight);

            // if too small, discard
            if (radiusOnScreen < 150.0) {
                continue;
            }

            node.weight = thisNode.weight;
            visible.push(node);

            // determine children worthy of inheriting the lineage
            let children = node.subdivide(zeroReturn);

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

                    let cameraToChildDistance = vec3.dist(eye, child.position);
                    let targetToChildDistance = vec3.dist(target, child.position);
                    let childDistanceFromTargetY = Math.abs(child.position[1] - target[1]);

                    // the large the radius the higher the weight, effected inversely by how how far it is from our view
                    // also affected inversely how far from the target point the child is
                    /*
                     let weight = child.radius /
                     (Math.sqrt(targetToChildDistance) * Math.pow(childDistanceFromY, 3));
                     */

                    let [_, childRadiusOnScreen] = screenSizeForBox(child, fov, cameraToChildDistance, clientHeight);

                    let weight = 1 / cameraToChildDistance * childDistanceFromTargetY;

                    if (childRadiusOnScreen < 300.0) {
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

        // turn the linear list into a hierarchy
        let cs = util.perf_start();
        visible.forEach(n => {
            if (n.parent) {
                let children = n.parent.wc || [];
                children.push(n);
                n.parent.wc = children;
            }
        });
        let ce = util.perf_end(cs);
        console.log("collate time:", ce);

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

        let loader = new Preloader(o.loaders.point, center, startDepth);
        lastLoader = loader;

        let root = visible[0];
        visible = [];
        console.log("starting walk", visible.length);
        let walkStart = util.perf_start();
        loader.walkTree(root, n => {
                // this is the node which needs to go into the renderer
                visible.push(n);

                // make sure we update our nodes with this newly added node so that
                // next frame we can remove it
                if (_.findIndex(o.nodes, 'id', n.id) === -1) {
                    o.nodes.push(n);
                }

                // since we don't want to wait for the whole tree traversal to happen before loading buffers
                // we add visible buffers right away
                o.renderer.addPointBuffer(makeId(n));
            },
            () => {
                let we = util.perf_end(walkStart);
                console.log("walk done!", we, "clearing up going away nodes.");

                var nodesToRemove = diff(o.nodes, visible);
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
    });

	// make sure view properties are triggered through our trigger mechanism
    o.propListener = o.renderer.addPropertyListener(["view"], function(view) {
        trigger.val(view);
    });

    return o.propListener;
};


module.exports = {
    FrustumLODNodePolicy: FrustumLODNodePolicy
};
