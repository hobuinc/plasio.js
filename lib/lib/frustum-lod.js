// greyhound-lod.js
// Greyhound data fetch as a quadtree
//

var gh = require("greyhound.js"),
    EventEmitter = require("events").EventEmitter,
    vec3 = require("gl-matrix").vec3,
    vec4 = require("gl-matrix").vec4,
    vec2 = require("gl-matrix").vec2,
	mat4 = require("gl-matrix").mat4,
    inherits = require('util').inherits,
    createHash = require('sha.js'),
    _ = require("lodash"),
    util = require("./util"),
    TriggeredDispatch = util.TriggeredDispatch;

var Box = function(x, y, z, w, h, d, id, depth) {
	this.x = x; this.y = y ; this.w = w, this.h = h;
	this.z = z; this.d = d;

	this.id = id || "R";
	this.depth = depth || 0;
};

Box.prototype.subdivide = function(zeroReturn) {
	var x = this.x, y = this.y, z = this.z;
	var w = this.w, h = this.h, d = this.d;

    // am I zero return?
    if (zeroReturn &&
        zeroReturn(x, y, z, x + w, y + h, z + d)) {
        return [];
    }

    // what is our split strategy, we don't want to split to 8 children at each node, our date is mostly

    var area = w * h;
    var areaLimit = 500 * 500;

    console.log("Area is:", area, "/", areaLimit, " at depth ", this.depth);

    var boxes = null;
    if (area < areaLimit) {
        // 50x50, no split
        var id0 = this.id + 0;
        var depth = this.depth + 1;

        boxes = [
            new Box(x, y, z, w, h, d, id0, depth)
        ]
    }
    else if (this.depth % 2 !== 0) {
        // split 8 ways
        var id0 = this.id + 0;
        var id1 = this.id + 1;
        var id2 = this.id + 2;
        var id3 = this.id + 3;
        var id4 = this.id + 4;
        var id5 = this.id + 5;
        var id6 = this.id + 6;
        var id7 = this.id + 7;

        var depth = this.depth + 1;

        boxes = [
            // bottom quad
            new Box(x, y, z, w/2, h/2, d/2, id0, depth), new Box(x + w/2, y, z, w/2, h/2, d/2, id1, depth),
            new Box(x, y + h/2, z, w/2, h/2, d/2, id2, depth), new Box(x + w/2, y + h/2, z, w/2, h/2, d/2, id3, depth),

            // top quad
            new Box(x, y, z + d/2, w/2, h/2, d/2, id4, depth), new Box(x + w/2, y, z + d/2, w/2, h/2, d/2, id5, depth),
            new Box(x, y + h/2, z + d/2, w/2, h/2, d/2, id6, depth), new Box(x + w/2, y + h/2, z + d/2, w/2, h/2, d/2, id7, depth)
        ];
    }
    else {
        // split 4 ways
        var id0 = this.id + 0;
        var id1 = this.id + 1;
        var id2 = this.id + 2;
        var id3 = this.id + 3;

        var depth = this.depth + 1;

        boxes = [
            // the only quad, don't split Z
            new Box(x, y, z, w/2, h/2, d, id0, depth), new Box(x + w/2, y, z, w/2, h/2, d, id1, depth),
            new Box(x, y + h/2, z, w/2, h/2, d, id2, depth), new Box(x + w/2, y + h/2, z, w/2, h/2, d, id3, depth),
        ];
    }

    // are any of the children zero return?
    if (zeroReturn) {
        return boxes.filter(function(b) {
            return !zeroReturn(b.x, b.y, b.z, b.x + b.w, b.y + b.h, b.z + b.z);
        });
    }

    return boxes;
};


var zeroReturn = null;

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
	var mins = [box.x, box.z, box.y, 1], maxs = [box.x+box.w, box.z + box.d, box.y+box.h, 1];

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

function intersectBoxToDepth(baseDepth, finalDepth, box, frustum, viewMatrix) {
    console.log("intersecting boxes", baseDepth, finalDepth);
	var rec = function(b, l, f) {
		//var i = intersectsPlanes(b, planes, viewMatrix);
            
		var inview = intersectFrustum(frustum, b);

		if (inview) {
			// emit this block, include information about at which depth it intersected
			//
			b.depth = l;
			f(b);
		}
		else
            return; // we're done becuase we don't intersect any further

		if (l === finalDepth)
			return; // we've gone far enough

		// for each child, go further down
		var boxes = b.subdivide(zeroReturn);
		boxes.forEach(function(bx) {
			rec(bx, l+1, f);
		});
	};

	var boxes = [];
	rec(box, baseDepth, function(b) {
		boxes.push(b);
	});

	return boxes;
}

var generateAllFrustums = (function() {
    var proj = mat4.create();

    var toRads = function(a) {
        return Math.PI * a / 180.0;
    };

    return function(aspect, fov, viewMatrix, clipDistances) {
        var frustums = 
                clipDistances.map(function(d) {
                    mat4.perspective(proj, toRads(fov), aspect, 0.1, d);
                    return frustumPlanes(proj, viewMatrix);
                });

        return frustums;
    };
})();

function allBoxesForThisView (box, baseDepth, clipDistances, aspect, fov, view) {
    console.log(box, baseDepth, clipDistances, aspect, fov, view);
    
	var depth = clipDistances.length;
	var frustums = generateAllFrustums(aspect, fov, view, clipDistances);

	var allBoxes = [];
	for (var i = 0 ; i < depth ; i ++) {
        var endDepth = depth - i - 1;

		var boxes = intersectBoxToDepth(baseDepth, baseDepth + endDepth,
                                        box, frustums[i], view);

		allBoxes = allBoxes.concat(boxes);
        console.log(i, boxes.length);
	}

    //return [];
	return allBoxes;
};


FrustumLODNodePolicy.prototype.start = function() {
    var o = this;

    // first things first, download the meta information file and see what
    // we're dealing with
    var bbox = o.bbox;
    var bb = new gh.BBox(bbox.slice(0, 3),
                         bbox.slice(3, 6));

	// although we have bounding box here provided to us by the user, we should
    // always simulate this as an async thing, since certain policies will
    // probably fetch it from the server.
	setTimeout(function() {
        o.emit("bbox", bb);
	});

    var center = bb.center();
	var icenter = [-center[0], -center[1], -center[2]];

    var region = { cx: bb.maxs[0] - bb.mins[0], cy: bb.maxs[1] - bb.mins[1] };
	var startDepth = 0;

	o.renderer.setRenderOptions({xyzScale: [1, 1, 1]});
	o.nodes = [];

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
        var depthEnd = node.depth;
        var depthBegin = (depthEnd === startDepth) ? 0 : (depthEnd - 1);

	    if (l.point) {
            id[l.point.constructor.key] =
                l.point.queryFor(bbox, depthBegin, depthEnd);
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

	var viewMatrix = null;
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
	    var near = camera.near || 0.01;
	    var far = camera.far || 1000.0;
        var baseDepth = 8; // this is always a good base depth
        var planesNeeded = Math.max(0, (o.maxDepth - o.maxDepthReduction) - baseDepth);

        // a 3rd of the planes from our eye will be going away in distance linearly
        // beyond that we start a cubic range where large steps happen
        //
        var linearNeeded = Math.floor(planesNeeded / 3);
        var quadNeeded = planesNeeded - linearNeeded;

        var quadraticRange = function(x) {
            return far * (x * x * x * x);
        };

        console.log("max-depth", o.maxDepth, "planesNeeded:", planesNeeded, "linearNeeded:", linearNeeded, "quadNeeded:", quadNeeded); 

        var thisSeries = [];

        for (var i = 0 ; i < linearNeeded ; i ++) {
            thisSeries.push(o.closestPlaneDistance * (i + 1));
        }

        var sd = thisSeries[thisSeries.length - 1];
        for (var i = 0 ; i < quadNeeded ; i ++) {
            thisSeries.push(sd + quadraticRange(1 / (quadNeeded - i)));
        }


        console.log("---------------- SERIES:", thisSeries);
        

	    startDepth = Math.max(0, o.maxDepth - thisSeries.length - o.maxDepthReduction);


	    // now create a projection matrix
	    var fov = camera.fov || 75;
	    var figureAspect = function() {
		    var width = window.innerWidth,
		        height = window.innerHeight;

            console.log("window size:", width, height);

		    return (width > height) ? width / height : height / width;
	    };

	    // TODO: this is need a much better way to determine what the aspect is going to be
	    var aspect = (typeof(window) === "object") ? figureAspect() : 1.0;
	    console.log("frustum perspective:", fov, aspect, near, far);

	    // create the view matrix
	    // since we're going to be needing it everywhere, node that we can inverse transform most stuff
	    // out of view space into model space, but its sort of working right now with this, so I am not going
	    // to touch it.
	    var e = [eye[0], eye[1], eye[2]];
        /*
        var e = [-100, -100, -100];
        var target = [0, 0, 0];
         */
        console.log(e, target);
	    viewMatrix = mat4.lookAt(viewMatrix || mat4.create(), e, target, [0, 1, 0]);
        var scale = mat4.fromScaling(mat4.create(), [-1, 1, 1]);
        mat4.multiply(viewMatrix, viewMatrix, scale);

	    // setup the base box;
	    var baseBox = new Box(bb.mins[0] - center[0],
	                          bb.mins[1] - center[1],
	                          bb.mins[2] - center[2],
	                          bb.maxs[0] - bb.mins[0],
	                          bb.maxs[1] - bb.mins[1],
	                          bb.maxs[2] - bb.mins[2]);

	    var boxList = allBoxesForThisView(baseBox, startDepth,
	                                      thisSeries,
                                          fov, aspect, viewMatrix);

	    // make sure that only new buffers are loaded in right
	    //
	    var diff = function(a, b) {
		    return _.filter(a, function(n) { return !_.findWhere(b, n); });
	    };

        var nodes = _.uniq(boxList, function(n) { return n.id + ":" + n.depth; });
        var newNodes = diff(nodes, o.nodes);
		var nodesToRemove = diff(o.nodes, nodes);

		console.log('New nodes this query:', newNodes.length);
		console.log('Nodes going away this query:', nodesToRemove.length);
		o.nodes = _.union(_.difference(o.nodes, nodesToRemove), newNodes);

		console.log('Nodes in scene:', o.nodes.length);
	    var deepestNodeDepth = _.max(o.nodes, function(n) {
            return n.depth;
        }).depth;

	    console.log('Deepest node:', deepestNodeDepth);

	    console.log('Nodes at deepest:',
                _.filter(o.nodes, function(n) {
                    return n.depth === deepestNodeDepth;
                }).length);

	    var goingDeep = _.find(o.nodes, function(n) {
		    return n.depth > (thisSeries.length / 2);
	    }) ? true : false;

	    /*
	    o.renderer.setRenderOptions({
		    pointSize: 2,
		    circularPoints: 1,
		    pointSizeAttenuation: [1, 0.2]
	    });
	     */

	    /*
	    if (goingDeep) {
	    }
	    else {
		    o.renderer.setRenderOptions({
			    pointSize: 2,
			    circularPoints: 0,
			    pointSizeAttenuation: [1, 0]
		    });
	    }
	     */

        _.forEach(newNodes, function(n) {
            o.renderer.addPointBuffer(makeId(n));
        });

        _.forEach(nodesToRemove, function(n) {
            o.renderer.removePointBuffer(makeId(n));
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
