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

var Box = function(x, y, w, h, id, depth) {
	this.x = x; this.y = y ; this.w = w, this.h = h;
	this.id = id || "R";
	this.depth = depth || 0;
};

Box.prototype.subdivide = function() {
	var x = this.x, y = this.y;
	var w = this.w, h = this.h;

	var id0 = this.id + 0;
	var id1 = this.id + 1;
	var id2 = this.id + 2;
	var id3 = this.id + 3;

	var d = this.depth + 1;

	return [
		new Box(x, y, w/2, h/2, id0, d), new Box(x + w/2, y, w/2, h/2, id1, d),
		new Box(x, y + h/2, w/2, h/2, id2, d), new Box(x + w/2, y + h/2, w/2, h/2, id3, d)
	];
};

var FrustumLODNodePolicy = function(loaders, renderer, bbox) {
    if (!loaders.point || !loaders.transform)
        throw new Error("The loaders need to have point buffer and transform loaders");

    this.renderer = renderer;
    this.bbox = bbox;
	this.loaders = loaders;

	var bbrx = bbox[2] - bbox[0],
	    bbry = bbox[3] - bbox[1];

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

FrustumLODNodePolicy.prototype._hookupDebug = function() {
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

		planes[4] = [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]];
		planes[5] = [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]];

		planes.forEach(norm);

		return planes;
	};
})();


// Given the 6 frustum planes, a bbox and a viewMatrix, this function figures if the
// box intersects the bbox
//
function intersectFrustum(planes, box, viewMatrix) {
	var mins = [box.x, 0, box.y, 1], maxs = [box.x+box.w, 1, box.y+box.h, 1];

	var dist = function(p, v) {
		return vec3.dot(p, v) + p[3];
	};

	var points = [];
	for (var i = 0 ; i < 8 ; i ++) {
		var b0 = i & 1, b1 = (i >> 1) & 1, b2 = (i >> 2) & 1;

		var px = b0 ? mins[0] : maxs[0],
		    py = b1 ? mins[1] : maxs[1],
		    pz = b2 ? mins[2] : maxs[2];

		points.push(vec3.transformMat4(vec4.create(), [px, py, pz, 1], viewMatrix));
	}

	// each of the bounding box needs to be on the wrong side for the bbox to be be completely rejected
	for (var j = 0 ; j < planes.length ; j ++) {
		var p1 = planes[j];
		var v = false;
		for (var i = 0 ; i < 8 && !v ; i ++) {
			var d = dist(p1, points[i]);
			
			v = (d > 0);
		}

		// the box is complete outside the frame of this plane
		if (!v) return false;
	}

	return true;
};


function intersectBoxToLevel(box, level, frustum, viewMatrix) {
	var rec = function(b, l, f) {
		//var i = intersectsPlanes(b, planes, viewMatrix);
		var i = intersectFrustum(frustum, b, viewMatrix);

		if (i) f(b);
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


function allBoxesForThisView (box, clipPlanes, proj, view) {
	// Pass 1, don't go too deep into the tree, we want to reject regions fast
	// Step 1.1: Figure out all boxes of interest given our clip planes for the first
	// five levels
	var pass1Depth = Math.min(clipPlanes.length, 13);
	var frustum = frustumPlanes(proj);

	var allBoxes = [];
	for (var i = 0 ; i < pass1Depth ; i ++) {
		var startDepth = (pass1Depth - i);
		var planes = clipPlanes[i];

		// build frustum using the four planes on the sides and our near and far planes
		var frus = [
			frustum[0], frustum[1], frustum[2], frustum[3],
			planes[0], planes[1]
		];

		var boxes = intersectBoxToLevel(box, startDepth, frus, view);
		allBoxes = allBoxes.concat(boxes);
	}

	return allBoxes;
};


FrustumLODNodePolicy.prototype.start = function() {
    var o  = this;

    // first things first, download the meta information file and see what we're dealing with
    //
    var bbox = o.bbox;
    var bb = new gh.BBox(bbox.slice(0, 2).concat(0),
                         bbox.slice(2, 4).concat(1));

    o.emit("bbox", bb);

    var center = bb.center();
	var icenter = [-center[0], -center[1], -center[2]];

    var region = { cx: bb.maxs[0] - bb.mins[0], cy: bb.maxs[1] - bb.mins[1] };

	o.renderer.setRenderOptions({xyzScale: [1, 1, 1]});

    var l = o.loaders;
    var makeId = function(node) {
        var id = {};

	    // make sure the points are in a valid coordinate system, offset them by the center
	    var x = node.x + center[0],
	        y = node.y + center[1];

        var bbox = new gh.BBox([x, y, 0],
                               [x + node.w, y + node.h, 1]);

	    console.log("offseting stuff:", bbox, center);
	    
        var worldBBox = bbox.offsetBy(center);
        var depth = 8;
        var startDepth = 0;

        id[l.point.constructor.key] = l.point.queryFor(bbox, startDepth, depth);
        id[l.overlay.constructor.key] = l.overlay.queryFor(bbox);
        id[l.transform.constructor.key] = l.transform.queryFor(worldBBox, bbox);

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
		    console.log("FrustumLODNodePolicy only supports perspective cameras for now");
		    return;
	    }

		// setup current projection and view matrices
	    var near = camera.near || 0.01;
	    var far = camera.far || 1000.0;
	    var TOTAL_SECTIONS = 10;

	    // generate the clip plane pairs that will determine our LOD offsets
	    var distance = function(a) {
		    // a simple distance function of clip planes down the Z axis
		    var fac = a / TOTAL_SECTIONS;
		    fac *= fac;

		    return near +  (far - near) * fac;
	    };


	    var clipPlanes = [];
	    for (var i = 0 ; i < TOTAL_SECTIONS ; i ++) {
		    var dstart = distance(i);
		    var dend = distance(i+1);

		    clipPlanes.push([[0, 0, -1, -dstart], [0, 0, 1, dend]]);
	    }


	    // now create a projection matrix
	    var fov = camera.fov || 70;
	    projectionMatrix = mat4.perspective(projectionMatrix || mat4.create(), fov, 1.0, near, far);


	    // create the view matrix
	    // since we're going to be needing it everywhere, node that we can inverse transform most stuff
	    // out of view space into model space, but its sort of working right now with this, so I am not going
	    // to touch it.
	    viewMatrix = mat4.lookAt(viewMatrix || mat4.create(), eye, target, [0, 1, 0]);

	    // setup the base box;
	    var baseBox = new Box(bb.mins[0] - center[0],
	                          bb.mins[1] - center[1],
	                          bb.maxs[0] - bb.mins[0],
	                          bb.maxs[1] - bb.mins[1]);

	    var boxList = allBoxesForThisView(baseBox, clipPlanes,
	                                      projectionMatrix, viewMatrix);

	    console.log(boxList);

	    // Now we have our view boxes list
	    boxList = _.take(boxList, 5);
	    boxList.forEach(function(b) {
		    o.renderer.addPointBuffer(makeId(b));
	    });
	    
    });

	// make sure view properties are triggered through our trigger mechanism
    o.propListener = o.renderer.addPropertyListener(["view"], function(view) {
	    console.log("changed!", view);
        trigger.val(view);
    });

    return o.propListener;
};


module.exports = {
    FrustumLODNodePolicy: FrustumLODNodePolicy
};
