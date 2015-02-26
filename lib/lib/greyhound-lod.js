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

var Node = function(x, y, w, h, d) {
	this.x = x;
	this.y = y;
	this.h = h;
	this.w = w;
	this.depth = d;

	this.children = [];
};

Node.prototype.subdivide = function() {
	if (this.depth === 0)
		return;

	var x = this.x;
	var y = this.y;
	var w = this.w;
	var h = this.h;
	

	var d = this.depth;

	this.children.push(new Node(x, y, w/2, h/2, d-1));
	this.children.push(new Node(x+w/2, y, w/2, h/2, d-1));
	this.children.push(new Node(x, y+h/2, w/2, h/2, d-1));
	this.children.push(new Node(x+w/2, y+h/2, w/2, h/2, d-1));

	this.children[0].subdivide();
	this.children[1].subdivide();
	this.children[2].subdivide();
	this.children[3].subdivide();
};

Node.prototype.lodQuery = function(eye, lodSpheres, startLOD, callback) {
	var C1 = { x: this.x, y: this.y }, C2 = { x: this.x+this.w, y: this.y+this.h };
	var intersects = doesCubeIntersectSphere(C1, C2, eye, lodSpheres[startLOD]);

	if (!intersects)
		return;

	// if we are already at the bottom of the tree, just emit
	if (startLOD === 0 || this.children.length === 0) {
		return callback(this);
	}

	// we got more LOD levels to go, check if a part of this cell
	// intersects a lower LOD level
	var intersectsLower =
			doesCubeIntersectSphere(C1, C2, eye, lodSpheres[startLOD-1]);
    
	if (!intersectsLower) // doesn't intersect any lower LOD nodes, so return
		return callback(this);

	for (var i = 0 ; i < this.children.length ; i++) {
		var c = this.children[i];

		callback(c); // emit current cell at current depth (or LOD)
		if (doesCubeIntersectSphere({x: c.x, y: c.y}, {x: c.x+c.w, y: c.y+c.h},
				                    eye, lodSpheres[startLOD-1])) {
			c.lodQuery(eye, lodSpheres, startLOD - 1, callback);
		}
	}
};

Node.prototype.collectNodes = function() {
	var thisArr = [this];

	if (this.children.length > 0)
		return thisArr.concat(
			this.children[0].collectNodes(),
			this.children[1].collectNodes(),
			this.children[2].collectNodes(),
			this.children[3].collectNodes());

	return thisArr;
};

var QuadTree = function(x, y, w, h, maxDepth, LODLevels) {
	this.x = x;
	this.y = y;
	this.w = w;
	this.h = h;
	this.maxDepth = maxDepth;

	if (LODLevels == undefined) {
		LODLevels = [];

		var distF = function(i) { return Math.pow(i, 1/5.0); };

		var maxVal = distF(maxDepth);
		for (var i = maxDepth ; i >= 0 ; i--) {
			LODLevels.push(0.005 + 0.995 * (1.0 - (distF(i) / maxVal)));

		}
	}

	console.log(LODLevels);
	this.updateLODSpheres(LODLevels);
    console.log(this.lodSpheres);

	this.root = new Node(x, y, w, h, maxDepth);
	this.root.subdivide();

	this.entireTree = this.root.collectNodes();
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

QuadTree.prototype.lodQuery = function(eyePos, callback) {
	this.root.lodQuery(eyePos, this.lodSpheres, this.lodSpheres.length - 1, callback);
};

QuadTree.prototype.LODSpheres = function() {
	return this.lodSpheres;
};

QuadTree.prototype.allNodes = function() {
	return this.entireTree;
};

var QuadTreeNodePolicy = function(loaders, renderer, bbox) {
    if (!loaders.point || !loaders.transform)
        throw new Error("The loaders need to have point buffer and transform loaders");

    this.renderer = renderer;
    this.bbox = bbox;
    this.maxDepth = 5;
    var lodLevels = [0.000001, 0.00001, 0.0001, 0.001, 0.01, 0.1, 0.15, 0.2];

    this.tree = new QuadTree(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1], this.maxDepth);

    this.loaders = loaders;

    this.nodes = [];
};


var ppoint = function(data, idx) {
    var f = new Float32Array(data.buffer);
    var off = idx * 8;
    console.log("x:", f[0], "y:", f[1], "z:", f[2],
                "r:", f[3], "g:", f[4], "b:", f[5],
                "i:", f[6], "c:", f[7]);
};

inherits(QuadTreeNodePolicy, EventEmitter);

QuadTreeNodePolicy.prototype.stop = function() {
    this.renderer.removePropertyListener(this.propListener);
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


    var l = o.loaders;
    var makeId = function(node) {
        var id = {};

        var bbox = new gh.BBox([node.x, node.y, 0],
                               [node.x + node.w, node.y + node.h, 1]);


        var worldBBox = bbox.offsetBy(center);
        var depth = 15 - node.depth * 2;

        id[l.point.constructor.key] = l.point.queryFor(bbox, depth - 2, depth);
        id[l.overlay.constructor.key] = l.overlay.queryFor(bbox);
        id[l.transform.constructor.key] = l.transform.queryFor(worldBBox, bbox);

        return id;
    };
    

    var trigger = new TriggeredDispatch(500, function(view) {
        if (!view)
            return;

        var eye = view.eye;
        var target = view.target;
        
        if (eye === null || target === null)
            return;

        var nodes = [];
        var pos = {
            x: center[0] - target[0], y: center[1] + target[2]
        };
        console.log(pos);
        
        o.tree.lodQuery(pos, function(b) {
            nodes.push(b);
        });

        nodes = _.uniq(nodes);
        var newNodes = _.difference(nodes, o.nodes);
		var nodesToRemove = _.difference(o.nodes, nodes);
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
