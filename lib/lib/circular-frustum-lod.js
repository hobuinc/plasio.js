// greyhound-lod.js
// Greyhound data fetch as a quadtree
//

var gh = require("greyhound.js"),
    EventEmitter = require("events").EventEmitter,
    vec3 = require("gl-matrix").vec3,
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

    if (Box.zboundsForBbox) {
        // if we have zbounds query setup, lets query it
        //
        var range = Box.zboundsForBbox(x, y, x + w, y + h);
        if (range !== null &&
            !(isNaN(range[0]) || isNaN(range[1]))) {
            this.z = range[0];

            var diff = range[1] - range[0];
            if (Math.abs(diff) < 0.00001) {
                // too close
                this.d = range[0] + range[0] * 1.1;
            }
            else {
                this.d = range[1];
            }
        }
    }

	this.id = id || "R";
	this.depth = depth || 0;
};

Box.zboundsForBbox = null;

Box.prototype.subdivide = function() {
	var x = this.x, y = this.y;
	var w = this.w, h = this.h;

	var id0 = this.id + 0;
	var id1 = this.id + 1;
	var id2 = this.id + 2;
	var id3 = this.id + 3;

	var d = this.depth + 1;

	return [
		new Box(x, y, this.z, w/2, h/2, this.d, id0, d), new Box(x + w/2, y, this.z, w/2, h/2, this.d, id1, d),
		new Box(x, y + h/2, this.z, w/2, h/2, this.d, id2, d), new Box(x + w/2, y + h/2, this.z, w/2, h/2, this.d, id3, d)
	];
};

var CircularFrustumLODNodePolicy = function(
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

	this.debug = {};
};

var ppoint = function(data, idx) {
    var f = new Float32Array(data.buffer);
    var off = idx * 8;
    console.log("x:", f[0], "y:", f[1], "z:", f[2],
                "r:", f[3], "g:", f[4], "b:", f[5],
                "i:", f[6], "c:", f[7]);
};

inherits(CircularFrustumLODNodePolicy, EventEmitter);

CircularFrustumLODNodePolicy.prototype.stop = function() {
    this.renderer.removePropertyListener(this.propListener);
    this.renderer.removePropertyListener(this.cameraPropsListener);
};

CircularFrustumLODNodePolicy.prototype.setImagerySource = function(imagerySource) {
    if (this.clearAll)
        this.clearAll();

    this.imagerySource = imagerySource;
    this.nodes = [];

    if (this.simulateVal)
        this.simulateVal();
};

CircularFrustumLODNodePolicy.prototype._hookupDebug = function() {
};


CircularFrustumLODNodePolicy.prototype.setDistanceHint = function(hint) {
	this.closestPlaneDistance = hint;
	if (this.simulateVal)
		this.simulateVal();
};


CircularFrustumLODNodePolicy.prototype.setMaxDepthReductionHint = function(maxDepthReduction) {
	this.maxDepthReduction = maxDepthReduction;
	if (this.simulateVal)
		this.simulateVal();
};


// given a view matrix, figure out the planes in view space, puts
// the extracted planes in planes
var frustumPlanes = (function() {
	var planes = new Array(6);

	var norm = function(p) {
		var f = vec3.length(p);

		p[0] /= f;
		p[1] /= f;
		p[2] /= f;
		p[3] /= f;
	};

	return function(m) {
		planes[0] = [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]];
		planes[1] = [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]];

		planes[2] = [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]];
		planes[3] = [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]];

		planes.forEach(norm);
		return planes;
	};
})();


var boxIntersectsSphere = function(C1, C2, S, R) {
    var dist_squared = R * R;
    var squared = function(x) { return x * x; };

    /* assume C1 and C2 are element-wise sorted, if not, do that now */
    if (S[0] < C1[0]) dist_squared -= squared(S[0] - C1[0]);
    else if (S[0] > C2[0]) dist_squared -= squared(S[0] - C2[0]);
    if (S[1] < C1[1]) dist_squared -= squared(S[1] - C1[1]);
    else if (S[1] > C2[1]) dist_squared -= squared(S[1] - C2[1]);
    if (S[2] < C1[2]) dist_squared -= squared(S[2] - C1[2]);
    else if (S[2] > C2[2]) dist_squared -= squared(S[2] - C2[2]);

    console.log(C1, C2, S, R, dist_squared);
    return dist_squared > 0;
};

// Given the 6 frustum planes, a bbox and a viewMatrix, this function figures if the
// box intersects the bbox
//
function intersectFrustumAndSphere(planes, box, eye, radius) {
	var mins = [box.x, box.z, box.y, 1], maxs = [box.x+box.w, box.d, box.y+box.h, 1];

    var i = boxIntersectsSphere(mins, maxs, eye, radius);

    console.log(i);
    return i;

    if (!boxIntersectsSphere(mins, maxs, eye, radius))
        return false;

	var dist = function(p, v) {
		return vec3.dot(p, v) + p[3];
	};

	var points = [];
	for (var i = 0 ; i < 8 ; i ++) {
		var b0 = i & 1, b1 = (i >> 1) & 1, b2 = (i >> 2) & 1;

		var px = b0 ? mins[0] : maxs[0],
		    py = b1 ? mins[1] : maxs[1],
		    pz = b2 ? mins[2] : maxs[2];

		points.push([px, py, pz, 1]);
	}

	// each of the bounding box needs to be on the wrong side for the bbox to be be completely rejected
    console.log(planes, planes.length);
	for (var j = 0 ; j < planes.length ; j ++) {
		var p1 = planes[j];
		var v = false;

        // for the first 4 planes, do regular frustum check
        for (var i = 0 ; i < 8 && !v ; i ++) {
            console.log(j, p1, points[i]);
            var d = dist(p1, points[i]);

            v = (d > 0);
        }

		// the box is complete outside the frame of this plane
		if (!v) return false;

		// the near and far distances are what the
	}

	return true;
};




function intersectBoxToLevel(box, startDepth, level, eye, radius, frustum, viewMatrix) {
	var rec = function(b, l, f) {
		//var i = intersectsPlanes(b, planes, viewMatrix);
		var i = intersectFrustumAndSphere(frustum, b, eye, radius, viewMatrix);

		if (i) {
			// emit this block, include information about at which depth it intersected
			//
			b.depth = startDepth + l + 1;
			f(b);
		}
		else return; // we're done becuase we don't intersect any further

		if (l === level)
			return; // we've gone far enough

		// for each child, go further down
		var boxes = b.subdivide();
		boxes.forEach(function(bx) {
			rec(bx, l+1, f);
		});
	};

	var boxes = [];
	rec(box, 0, function(b) {
		boxes.push(b);
	});

	return boxes;
};


function allBoxesForThisView (box, baseDepth, eye, radii, proj, view) {

	var depth = radii.length;
	var frustum = frustumPlanes(mat4.multiply(mat4.create(),
                                              proj,
                                              mat4.invert(mat4.create(), view)));

	var allBoxes = [];
	for (var i = 0 ; i < depth ; i ++) {
		var startDepth = (depth - i);
		var radius = radii[i];


		// build frustum using the four planes on the sides
		var frus = [
			frustum[0], frustum[1], frustum[2], frustum[3]
        ];

		var boxes = intersectBoxToLevel(box, baseDepth, startDepth, eye, radius, frus);
        console.log(radius, boxes.length, baseDepth, startDepth);
		allBoxes = allBoxes.concat(boxes);
	}

	return allBoxes;
};

CircularFrustumLODNodePolicy.prototype.loadHeightMap = function(cb) {
    var bufferLoader = this.loaders.point;
    if (!bufferLoader) {
        console.log("cannot load height map if point loader is unavailable");
        return setTimeout(cb);
    }

    var DEPTH_TO_QUERY = 10;

    // we do have a point loader, make it generate a query for us
    var bb = new gh.BBox(this.bbox.slice(0, 3),
                         this.bbox.slice(3, 6));

    var id = bufferLoader.queryFor(bb, 0, DEPTH_TO_QUERY);

    var o = this;

    console.log("query is", id);

    // load the buffer
    return bufferLoader.constructor.load(id, function(err, info) {
        if (err) {
            console.log("failed to load base buffer", err);
            return cb(err);
        }

        // now process the buffer and create a height map for it
        //
        var fieldSize = Math.floor(Math.pow(4, DEPTH_TO_QUERY / 2));

        var region = new Float32Array(fieldSize * fieldSize);

        for (var i = 0, il = fieldSize * fieldSize ; i < il ; i++) {
            region[i] = NaN;
        }

        var pointCount = info.totalPoints;
        var stride = info.pointStride / 4; // stride in floats

        var buffer = info.data;

        var mins = bb.mins;
        var maxs = bb.maxs;

        var rx = (maxs[0] - mins[0]),
            ry = (maxs[1] - mins[1]);
        
        var invrx = 1.0 / rx;
        var invry = 1.0 / ry;

        console.log(rx, ry);

        var offset = 0;

        for (var i = 0 ; i < pointCount ; i ++) {
            var x = buffer[offset],
                y = buffer[offset+1],
                z = buffer[offset+2];

            // find the offsets;
            var fx = (x - mins[0]) * invrx;
            var fy = (y - mins[1]) * invry;

            var xx = Math.floor(fx * fieldSize);
            var yy = Math.floor(fy * fieldSize);

            region[yy * fieldSize + xx] = z;

            offset += stride;
        }

        var offsetx = rx / 2,
            offsety = ry / 2;

        // memoize results;
        var mem = {};

        var sanitize = function(r) {
            var r0 = r[0],
                r1 = r[1];

            if (isFinite(r0) && isFinite(r1))
                return r;

            return null;
        };

        var zboundsForBbox = function(xmin, ymin, xmax, ymax) {
            var xs = Math.floor(fieldSize * (offsetx + xmin) / rx),
                xe = Math.floor(fieldSize * (offsetx + xmax) / rx),
                ys = Math.floor(fieldSize * (offsety + ymin) / ry),
                ye = Math.floor(fieldSize * (offsety + ymax) / ry);

            var key = xs + ":" + xe + ":" + ys + ":" + ye;


            if (mem[key]) {
                return sanitize(mem[key]);
            }

            var off = ys * fieldSize + xs;
            var nn = Math.min(),
                xx = Math.max();

            var set = [];

            for (y = ys ; y < ye ; y ++) {
                var toff = off;
                for (x = xs ; x < xe ; x ++) {
                    var z = region[toff];

                    set.push(z);


                    if (!isNaN(z)) {
                        nn = Math.min(z, nn);
                        xx = Math.max(z, xx);
                    }

                    toff += stride;
                }

                off += fieldSize * stride;
            }

            if (nn > xx) {
                console.log(set);
            }

            mem[key] = [nn, xx];
            return sanitize([nn, xx]);
        };

        return cb(null, {
            zboundsForBbox: zboundsForBbox
        });
    });
};

CircularFrustumLODNodePolicy.prototype.start = function() {
    var o = this;
    
    this.loadHeightMap(function(err, regionQuery) {
        if (!err) {
            Box.zboundsForBbox = regionQuery.zboundsForBbox;
        }

        o.start2();
    });
};


CircularFrustumLODNodePolicy.prototype.start2 = function() {
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
            z = node.z;

        var bbox = new gh.BBox([x, y, z],
                               [x + node.w, y + node.h, node.d]);

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

	var projectionMatrix = null;
	var viewMatrix = null;

	var planes = new Array(6);

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
        var baseDepth = 10; // this is always a good base depth
        var planesNeeded = Math.max(0, 1 + (o.maxDepth - o.maxDepthReduction) - baseDepth);

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

        /*
        for (var i = 0 ; i < quadNeeded ; i ++) {
            thisSeries.push(quadraticRange(1 / (i + 1)));
        }

        // now start with linear range
        for (var i = linearNeeded ; i > 0 ; i --) {
            thisSeries.push(o.closestPlaneDistance * i);
        }

        thisSeries.push(near);
        thisSeries.reverse();
         */

        for (var i = 0 ; i < linearNeeded ; i ++) {
            thisSeries.push(o.closestPlaneDistance * (1 << (i)));
        }

        var sd = thisSeries[thisSeries.length - 1];
        for (var i = 0 ; i < quadNeeded ; i ++) {
            thisSeries.push(sd + quadraticRange(1 / (quadNeeded - i)));
        }


        console.log("---------------- SERIES:", thisSeries);
        
	    // generate the clip plane pairs that will determine our LOD offsets
	    //var thisSeries = series();
	    var radii = [];

	    // add the first 4-5 planes at a good eye distance
	    //
	    for (var i = 0 ; i < thisSeries.length-1 ; i ++) {
		    var dstart = thisSeries[i];
            radii.push(thisSeries[i]);
	    }

	    startDepth = Math.max(0, o.maxDepth - thisSeries.length - o.maxDepthReduction);


	    // now create a projection matrix
	    var fov = camera.fov || 75;
	    var figureAspect = function() {
		    var width = window.innerWidth,
		        height = window.innerHeight;

		    return (width > height) ? width / height : height / width;
	    };

	    // TODO: this is need a much better way to determine what the aspect is going to be
	    var aspect = (typeof(window) === "object") ? figureAspect() : 1.0;
	    console.log("frustum perspective:", fov, aspect, near, far);
	    projectionMatrix = mat4.perspective(projectionMatrix || mat4.create(), fov, aspect, near, far);


	    // create the view matrix
	    // since we're going to be needing it everywhere, node that we can inverse transform most stuff
	    // out of view space into model space, but its sort of working right now with this, so I am not going
	    // to touch it.
	    var e = [-eye[0], eye[1], eye[2]];
	    viewMatrix = mat4.lookAt(viewMatrix || mat4.create(), e, target, [0, 1, 0]);

	    // setup the base box;
	    var baseBox = new Box(bb.mins[0] - center[0],
	                          bb.mins[1] - center[1],
	                          bb.mins[2] - center[2],
	                          bb.maxs[0] - bb.mins[0],
	                          bb.maxs[1] - bb.mins[1],
	                          bb.maxs[2] - bb.mins[2]);

        console.log(center);
	    var boxList = allBoxesForThisView(baseBox, startDepth,
                                          [-target[0], center[2] + target[1], target[2]],
	                                      radii,
	                                      projectionMatrix, viewMatrix);

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
    CircularFrustumLODNodePolicy: CircularFrustumLODNodePolicy
};
