// greyhound-lod.js 
// Greyhound data fetch as a quadtree
//

var gh = require("greyhound.js"),
    EventEmitter = require("events").EventEmitter,
    vec3 = require("gl-matrix").vec3,
    vec2 = require("gl-matrix").vec2,
    inherits = require('util').inherits,
    createHash = require('sha.js'),
    _ = require("lodash"),
    util = require("./util"),
    TriggeredDispatch = util.TriggeredDispatch;


var TOP_LEFT = 0;
var TOP_RIGHT = 1;
var BOTTOM_LEFT = 2;
var BOTTOM_RIGHT = 3;
var PARENT = 5;

function squared(v) { return v * v; }
function doesCubeIntersectSphere(C1, C2, S, R) {
	var dist_squared = R * R;

	/* assume C1 and C2 are element-wise sorted, if not, do that now */
	if (S.x < C1.x) dist_squared -= squared(S.x - C1.x);
	else if (S.x > C2.x) dist_squared -= squared(S.x - C2.x);
	if (S.y < C1.y) dist_squared -= squared(S.y - C1.y);
	else if (S.y > C2.y) dist_squared -= squared(S.y - C2.y);

	return dist_squared > 0;
}

var Node = function(x, y, w, h, d, dir, id) {
	this.x = x;
	this.y = y;
	this.h = h;
	this.w = w;
	this.depth = d;
	this.dir = dir;
	this.id = id ? id : "R";
};

Node.prototype.subdivide = function() {
	if (this.depth === 0)
		return [];

	var x = this.x;
	var y = this.y;
	var w = this.w;
	var h = this.h;
	

	var d = this.depth;

	return [
		new Node(x, y, w/2, h/2, d-1, TOP_LEFT, this.id + TOP_LEFT.toString()),
		new Node(x+w/2, y, w/2, h/2, d-1, TOP_RIGHT, this.id + TOP_RIGHT.toString()),
		new Node(x, y+h/2, w/2, h/2, d-1, BOTTOM_LEFT, this.id + BOTTOM_LEFT.toString()),
		new Node(x+w/2, y+h/2, w/2, h/2, d-1, BOTTOM_RIGHT, this.id + BOTTOM_RIGHT.toString())
	];
};

Node.prototype.lodQuery = function(eye, bailDepth, lodSpheres, startLOD, callback) {
	var C1 = { x: this.x, y: this.y }, C2 = { x: this.x+this.w, y: this.y+this.h };
	var intersects = doesCubeIntersectSphere(C1, C2, eye, lodSpheres[startLOD]);

	if (!intersects)
		return;

    // always emit ourselves, if we interesect
    callback(this);

	var children = this.subdivide();

	// if we are already at the bottom of the tree, just emit
	if (startLOD === bailDepth || startLOD === 0 || children.length === 0) {
		return;
	}

	// we got more LOD levels to go, check if a part of this cell
	// intersects a lower LOD level
	var intersectsLower =
		    doesCubeIntersectSphere(C1, C2, eye, lodSpheres[startLOD-1]);
    
	if (!intersectsLower) { // doesn't intersect any lower LOD nodes, so return
		return;
	}

	children.forEach(function(c) {
		callback(c); // emit current cell at current depth (or LOD)
		if (doesCubeIntersectSphere({x: c.x, y: c.y}, {x: c.x+c.w, y: c.y+c.h},
				                    eye, lodSpheres[startLOD-1])) {
			c.lodQuery(eye, bailDepth, lodSpheres, startLOD - 1, callback);
		}
	});
};

var QuadTree = function(x, y, w, h, maxDepth, LODLevels) {
	this.x = x;
	this.y = y;
	this.w = w;
	this.h = h;
	this.maxDepth = maxDepth;

	if (LODLevels == undefined) {
		LODLevels = [];

		var distF = function(i) { return i / maxDepth; };
		var maxVal = distF(maxDepth);
		for (var i = maxDepth ; i >= 0 ; i--) {
			LODLevels.push(0.005 + 0.995 * (1.0 - (distF(i) / maxVal)));
		}
	}

	console.log(LODLevels);
	this.lodSpheres = LODLevels;
	/*
	this.updateLODSpheres(LODLevels);
    console.log(this.lodSpheres);
	 */
	this.root = new Node(x, y, w, h, maxDepth);
};

QuadTree.prototype.numLODSpheresNeeded = function() {
	return this.maxDepth + 1;
};

QuadTree.prototype.updateLODSpheres = function(LODLevels) {
	var w = this.w;
	var h = this.h;

	var maxDist = Math.sqrt((w * w)+(h * h));
	this.lodSpheres = [];
	for (var i = 0 ; i < LODLevels.length ; i ++) {
		this.lodSpheres.push(LODLevels[i] * maxDist);
	}
};

QuadTree.prototype.lodQuery = function(eyePos, bailDepth, callback) {
	this.root.lodQuery(eyePos, bailDepth, this.lodSpheres, this.lodSpheres.length - 1, callback);
};

QuadTree.prototype.LODSpheres = function() {
	return this.lodSpheres;
};

var CELL_SIZE = 100;

var log2 = (function() {
	if (typeof Math.log2 !== "function") {
		return function(v) {
			return Math.log(v) * 1.4426950408889634; // log2(n) = log(n) / log(2); 1 / log(2) = 1.44...
		};
	}

	return Math.log2;
})();

var QuadTreeNodePolicy = function(loaders, renderer, bbox) {
    if (!loaders.point || !loaders.transform)
        throw new Error("The loaders need to have point buffer and transform loaders");

    this.renderer = renderer;
    this.bbox = bbox;

	var bbrx = bbox[2] - bbox[0],
	    bbry = bbox[3] - bbox[1];

	// what depth for our tree is required, so that we can show 4 adjacent levels
	// needed depth
	this.maxDepth = Math.ceil(log2(Math.max(bbrx, bbry) / CELL_SIZE)); // for a 100x100 cell what is the needed depth

    this.maxDepth = 11;

	var lodlevels = this.genLevels(1.0);

	console.log(this.maxDepth);
	console.log(lodlevels);

    this.tree = new QuadTree(bbox[0], bbox[1], bbrx, bbry, this.maxDepth, lodlevels);

    this.loaders = loaders;
    this.nodes = [];
	this.debug = {};
};

var ppoint = function(data, idx) {
    var f = new Float32Array(data.buffer);
    var off = idx * 8;
    console.log("x:", f[0], "y:", f[1], "z:", f[2],
                "r:", f[3], "g:", f[4], "b:", f[5],
                "i:", f[6], "c:", f[7]);
};

inherits(QuadTreeNodePolicy, EventEmitter);

QuadTreeNodePolicy.prototype.genLevels = function(ratio) {
	var lodlevels = [];

	var bbrx = this.bbox[2] - this.bbox[0],
	    bbry = this.bbox[3] - this.bbox[1];

	ratio = Math.max(ratio, 0.01);
	var max = Math.min(bbrx, bbry) * 0.15;

	var OFFSET = 3;
	
	for (var i = OFFSET ; i <= this.maxDepth + OFFSET ; i++) {
		var f = i / (this.maxDepth + 1);
		var s = Math.pow(f, 5);
		var r = max * s;
		lodlevels.push(r);
	}
	return lodlevels;
};


QuadTreeNodePolicy.prototype.stop = function() {
    this.renderer.removePropertyListener(this.propListener);
};


var reduceDirectional = function(node, times) {
	var red = function(node) {
		var l = node.x, r = node.x + node.w,
		    t = node.y, b = node.y + node.h,
		    w = node.w, h = node.h,
		    qw = w / 4, qh = h / 4;
		
		switch(node.dir) {
		case TOP_LEFT:       return {x: r - qw, y: b - qh, w: qw, h: qh, dir: node.dir, depth: node.depth };
		case TOP_RIGHT:      return {x: l, y: b - qh, w: qw, h: qh, dir: node.dir, depth: node.depth };
		case BOTTOM_LEFT:    return {x: r - qw, y: t, w: qw, h: qh, dir: node.dir, depth: node.depth };
		case BOTTOM_RIGHT:   return {x: l, y: t, w: qw, h: qh, dir: node.dir, depth: node.depth };
		}

		return node;
	};

	var n = node;
	for (var i = 0 ; i < times ; i ++) {
		n = red(n);
	};

	return n;
};

QuadTreeNodePolicy.prototype._hookupLODDebug = function() {
	var o = this;

	var inited = false;
	var program, buffer, pLoc, vLoc, vertexLoc, radiusLoc, shadeLoc, offLoc;

	var init = function(gl) {
		var buf = new Float32Array(64 * 3);
		for (var i = 0 ; i < 64 ; i ++) {
			var a = i * 2 * Math.PI / 64;
			buf[3 * i + 0] = Math.sin(a); // x
			buf[3 * i + 2] = Math.cos(a); // z
			buf[3 * i + 1] = 0.0;
		}

		var vs = "uniform mat4 v, p; uniform vec3 off; uniform float r; attribute vec3 pos; \
            void main(void) { gl_PointSize=50.0; gl_Position = p * v * vec4(pos * r + off, 1.0); }";
		
		var fs = "precision mediump float; uniform float shade; void main(void) { gl_FragColor = vec4(shade, 0.0, 0.0, 0.3); }";

		var vsh = gl.createShader(gl.VERTEX_SHADER);
		gl.shaderSource(vsh, vs);
		gl.compileShader(vsh);

		if (!gl.getShaderParameter(vsh, gl.COMPILE_STATUS)) {
			// Something went wrong during compilation; get the error
			throw "could not compile shader:" + gl.getShaderInfoLog(vsh);
		}

		var fsh = gl.createShader(gl.FRAGMENT_SHADER);
		gl.shaderSource(fsh, fs);
		gl.compileShader(fsh);

		if (!gl.getShaderParameter(fsh, gl.COMPILE_STATUS)) {
			// Something went wrong during compilation; get the error
			throw "could not compile shader:" + gl.getShaderInfoLog(fsh);
		}

		program = gl.createProgram();
		gl.attachShader(program, vsh);
		gl.attachShader(program, fsh);

		gl.linkProgram(program);

		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			// something went wrong with the link
			throw ("program filed to link:" + gl.getProgramInfoLog (program));
		}

		gl.useProgram(program);
		buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, null);

		pLoc = gl.getUniformLocation(program, "p");
		vLoc = gl.getUniformLocation(program, "v");
		offLoc = gl.getUniformLocation(program, "off");
		radiusLoc = gl.getUniformLocation(program, "r");
		shadeLoc = gl.getUniformLocation(program, "shade");
		vertexLoc = gl.getAttribLocation(program, "pos");
	};

	o.renderer.addPostRender(function(gl, mvp, mv, proj) {
		if (!inited) {
			init(gl);
			inited = true;
		}

        gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

        gl.enableVertexAttribArray(program, vertexLoc);
        gl.vertexAttribPointer(vertexLoc, 3, gl.FLOAT, false, 0, 0);

        gl.uniformMatrix4fv(vLoc, false, mv);
        gl.uniformMatrix4fv(pLoc, false, proj);

        if (o.debug.target) {
            var t = o.debug.target;
            gl.uniform3fv(offLoc, t);
        }

        gl.lineWidth(5.0);
        gl.enable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        var shp = o.tree.LODSpheres(),
            max = shp.length;

        shp.forEach(function(s, i) {
            gl.uniform1f(radiusLoc, s);
            gl.uniform1f(shadeLoc, (i + 1) / max);
            gl.drawArrays(gl.LINE_LOOP, 0, 64);
        });

        gl.depthMask(true);
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);

        gl.disableVertexAttribArray(program, vertexLoc);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
	});
};


QuadTreeNodePolicy.prototype.start = function() {
    var o  = this;

    // first things first, download the meta information file and see what we're dealing with
    //
    var bbox = o.bbox;
    var bb = new gh.BBox(bbox.slice(0, 2).concat(0),
                         bbox.slice(2, 4).concat(1));
    o.emit("bbox", bb);

    var center = bb.center();
    var region = { cx: bb.maxs[0] - bb.mins[0], cy: bb.maxs[1] - bb.mins[1] };

	o.renderer.setRenderOptions({xyzScale: [1, 1, 14]});

    var l = o.loaders;
    var makeId = function(node) {
        var id = {};

        var bbox = new gh.BBox([node.x, node.y, 0],
                               [node.x + node.w, node.y + node.h, 1]);


        var worldBBox = bbox.offsetBy(center);
        var depth = node.depth;
        var startDepth = node.startDepth ? node.startDepth : depth - 1;

        id[l.point.constructor.key] = l.point.queryFor(bbox, startDepth, depth);
        id[l.overlay.constructor.key] = l.overlay.queryFor(bbox);
        id[l.transform.constructor.key] = l.transform.queryFor(worldBBox, bbox);

        return id;
    };


	//this._hookupLODDebug();

	var regionDist = vec2.distance(this.bbox.slice(0, 2), this.bbox.slice(2, 4));
    var trigger = new TriggeredDispatch(500, function(view) {
        if (!view)
            return;

        var eye = view.eye;
        var target = view.target;
        
        if (eye === null || target === null)
            return;

	    o.debug.target = target;

	    var viewDist = vec3.distance(eye, target);
	    var ratio = viewDist / regionDist;

        var nodes = [];

        console.log("distance-ratio:", ratio);

	    // adjust some view options based on our ratio
	    o.renderer.setRenderOptions({
		    pointSize: 4,
		    circularPoints: 0,
		    pointSizeAttenuation: [1, 0]  // no contribution from point size attenuation
	    });

	    // always load the base node
        nodes.push({id: "ROOT",
                    x: o.bbox[0], y: o.bbox[1],
                    w: o.bbox[2] - o.bbox[0],
                    h: o.bbox[3] - o.bbox[1],
                    startDepth: 1,
                    depth: 10
                   });

	    // when getting closer load another layer
	    if (ratio < 0.3) {
		    // add 4 second level nodes
		    var w = o.bbox[2] - o.bbox[0],
		        h = o.bbox[3] - o.bbox[1],
		        x = o.bbox[0], y = o.bbox[1];


		    nodes.push({id: "ROOT1", x: x, y: y, w: w, h: h, depth: 11});
		    nodes.push({id: "ROOT2", x: x+w, y: y, w: w, h: h, depth: 11});
		    nodes.push({id: "ROOT3", x: x, y: y+h, w: w, h: h, depth: 11});
		    nodes.push({id: "ROOT4", x: x+w, y: y+h, w: w, h: h, depth: 11});
	    }

        
	    // close enough to do smarter things
        if (ratio < 0.1) {
	        // in our quad tree, the levels decrease as we go down, much confusion arises, but we can
	        // change it if it becomes impossible to deal with it, right now its manageable if you're not hungry
	        // or tired
	        var MAX_DEPTH = 19;
	        var levelsToDiscard = Math.floor(o.maxDepth / 2);
	        var levelsToKeep = o.maxDepth - levelsToDiscard;

	        // levels to keep tells us what quad tree resolutions we're interested in, here we want to only consider the bottom half of
	        // the tree, another factor controls how far we're willing to go down the tree as well, so if we're not interested in going all the way
	        // down into the tree yet, we can bail early
	        //
	        var bailAt = levelsToKeep; // this means we never get any nodes we can show, the bailing happens at the point where our nodes of interest start

	        // these factors are hand crafted, since I suck
	        if (ratio > 0.02) {
		        bailAt = Math.max(0, levelsToKeep - 1); // -ve since tree is downwards
	        }
	        else if (ratio > 0.01) {
		        bailAt = Math.max(0, levelsToKeep - 2); // -ve since tree is downwards
	        }
	        else if (ratio > 0.005) {
		        bailAt = Math.max(0, levelsToKeep - 3); // -ve since tree is downwards
	        }
	        else if (ratio > 0.001) {
		        bailAt = Math.max(0, levelsToKeep - 4); // -ve since tree is downwards
	        }
	        else {
		        bailAt = -1;
	        }

	        if (ratio < 0.003) {
		        o.renderer.setRenderOptions({
			        pointSize: 4,
			        circularPoints: 1,
			        pointSizeAttenuation: [1, 1] // only attenuation contribution
		        });
	        }


            console.log("view-params:", viewDist, ratio, bailAt, levelsToDiscard, levelsToKeep);

            var pos = {
                x: center[0] - target[0], y: center[1] + target[2]
            };

            var treeNodes = [];
            o.tree.lodQuery(pos, bailAt, function(b) {
                treeNodes.push(b);
            });

            treeNodes = _.filter(treeNodes, function(n) {
                return n.depth < levelsToKeep;
            });

            treeNodes = _.uniq(treeNodes, function(n) { return n.id; });

	        // on top of our base level 11 (10 on top level + 1 additional when we zoom in, we have MAX_LEVELS - 11 total levels left
            treeNodes = treeNodes.map(function(n) {
	            // each node's depth here is in the range levelsToKeep -> 0, we need to make it so that when a node
	            // with level 0 arrives, that basically means that we need full resolution at MAX_DEPTH for it
                n.depth = Math.floor(11 + (levelsToKeep - n.depth) * (MAX_DEPTH - 11) / levelsToKeep);
	            /*
                if (n.depth > 13) {
                    console.log("what?", n.depth);
                    n.depth = 13;
                }
	             */
                
                return n;
            });

            nodes = nodes.concat(treeNodes);
        }

        console.log(nodes);

	    var diff = function(a, b) {
		    return _.filter(a, function(n) { return !_.findWhere(b, n); });
	    };

        nodes = _.uniq(nodes, function(n) { return n.id; });

        var newNodes = diff(nodes, o.nodes);
		var nodesToRemove = diff(o.nodes, nodes);
		console.log('New nodes this query:', newNodes.length);
		console.log('Nodes going away this query:', nodesToRemove.length);
		o.nodes = _.union(_.difference(o.nodes, nodesToRemove), newNodes);
		console.log('Nodes in scene:', o.nodes.length);

        _.forEach(newNodes, function(n) {
            o.renderer.addPointBuffer(makeId(n));
        });

        _.forEach(nodesToRemove, function(n) {
            o.renderer.removePointBuffer(makeId(n));
        });
    });

    o.propListener = o.renderer.addPropertyListener(["view"], function(view) {
        trigger.val(view);
    });

    return o.propListener;
};


module.exports = {
    QuadTreeNodePolicy: QuadTreeNodePolicy
};
