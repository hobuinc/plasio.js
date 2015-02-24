// greyhound.js 
// Greyhound data fetch profiles
//

var gh = require("greyhound.js"),
    EventEmitter = require("events").EventEmitter,
    vec3 = require("gl-matrix").vec3,
    vec2 = require("gl-matrix").vec2,
    inherits = require('util').inherits,
    createHash = require('sha.js'),
    util = require("./util"),
    TriggeredDispatch = util.TriggeredDispatch;

var Cell = function(renderer, loaders, allBBox, bbox, globalOffset, defaultStartDepth, maxDepthLevel) {
    this.renderer = renderer;
    this.bbox = bbox;
    this.worldBBox = bbox.offsetBy(globalOffset);

    this.gcenter = util.geocenter(this.worldBBox);
    
    this.baseDepth = (defaultStartDepth || 8);
    this.depth = this.baseDepth;

    this.maxDist = util.geodist(allBBox.mins, allBBox.maxs);
    this.maxDepthLevel = (maxDepthLevel || 9);

    this.loaders = loaders;


               
    // queue the base volume
    this.addBuffer({depthBegin: 0, depthEnd: this.baseDepth});
};

Cell.prototype._makeId = function(specs) {
    var id = {};

    var l = this.loaders;

    id[l.point.constructor.key] = l.point.queryFor(this.bbox, specs.depthBegin, specs.depthEnd);
    id[l.overlay.constructor.key] = l.overlay.queryFor(this.bbox);
    id[l.transform.constructor.key] = l.transform.queryFor(this.worldBBox, this.bbox);

    return id;
};

Cell.prototype.addBuffer = function(specs) {
    this.renderer.addPointBuffer(this._makeId(specs));
};

Cell.prototype.removeBuffer = function(specs) {
    this.renderer.removePointBuffer(this._makeId(specs));
};

var figureDistance = function(start, end) {
    var x = start[0], y = start[1];

    var dist = 0;
    while (x !== end[0] || y !== end[1]) {
        // adjust x and y every frame so that they are closer to
        // the target
        if (x !== end[0])
            x += Math.sign(end[0] - x);

        if (y !== end[1])
            y += Math.sign(end[1] - y);

        dist++;
    }

    if (dist <= 1) dist = 0; // show neighbors at full res
    return dist;
};



Cell.prototype.updateCell = function(index, size) {
    var o = this;
    //var et = vec3.distance(target, eye); // the distance between the eye and the target

    var trow = Math.floor(index / size);
    var tcol = index % size;

    var row = Math.floor(this.index / size);
    var col = this.index % size;

    var dist = figureDistance([trow, tcol], [row, col]);

    var h = Math.max(this.baseDepth, this.maxDepthLevel - dist);
    console.log("update-cell " + o.index + ":", o.depth, "->", h);
    
    while (o.depth > h) {
        var qr = {
            depthBegin: o.depth-1,
            depthEnd: o.depth
        };

        console.log("removing!");
        o.removeBuffer(qr);
        o.depth --;
    }

    while(o.depth < h) {
        var qa = {
            depthBegin: o.depth,
            depthEnd: o.depth + 1
        };

        o.addBuffer(qa);
        o.depth ++;
    }
};


var NodeDistancePolicy = function(loaders, renderer, bbox) {
    this.renderer = renderer;
    this.bbox = new gh.BBox([bbox[0], bbox[1], 0], [bbox[2], bbox[3], 1]);

    if (!loaders.point || !loaders.transform)
        throw new Error("The loaders need to have point buffer and transform loaders");

    this.loaders = loaders;
};


inherits(NodeDistancePolicy, EventEmitter);

var ppoint = function(data, idx) {
    var f = new Float32Array(data.buffer);
    var off = idx * 8;
    console.log("x:", f[0], "y:", f[1], "z:", f[2],
                "r:", f[3], "g:", f[4], "b:", f[5],
                "i:", f[6], "c:", f[7]);
};

var splitTillDepth = function(bbox, depth) {
    var split = function(b, d) {
        var bxs = b.splitQuad();
        if (depth === d) return bxs;

        return [].concat(split(bxs[0], d + 1),
                         split(bxs[1], d + 1),
                         split(bxs[2], d + 1),
                         split(bxs[3], d + 1));
    };

    return split(bbox, 1);
};

var cellIntersect = function(cells, loc) {
    for (var i in cells) {
        var l = cells[i].worldBBox;
        if (util.ginside(l, loc))
            return cells[i];
    }

    return null;
};

NodeDistancePolicy.prototype.stop = function() {
    this.renderer.removePropertyListener(this.propListener);
};


NodeDistancePolicy.prototype.start = function() {
    var o  = this;

    // first things first, download the meta information file and see what we're dealing with
    //

    var bbox = new gh.BBox(o.bbox.mins, o.bbox.maxs);

    var splitDepth = 1;

    o.emit("bbox", bbox);

    var boxes = splitTillDepth(bbox, splitDepth);

    boxes = [bbox];
    
    var dim = Math.pow(2, splitDepth);

    // sorting
    boxes.sort(function(a, b) {
        var dx = b.mins[0] - a.mins[0];
        var dy = b.mins[1] - a.mins[1];

        if (Math.abs(dy) < 0.000001) {
            return dx;
        }

        return dy;
    });

    var globalOffset = bbox.center();
    var cells = boxes.map(function(box, index) {
        var c = new Cell(o.renderer, o.loaders, bbox, box, globalOffset, o.baseDepth, o.maxDepthLevel);
        c.index = index;
        return c;
    });

    var trigger = new TriggeredDispatch(500, function(view) {
        if (!view)
            return;
        
        var eye = view.eye;
        var target = view.target;
        
        if (eye === null || target === null)
            return;

        var cell = cellIntersect(cells, target);
        if (!cell)
            return; // doesn't intersect with any cell? forget about it

        var index = cell.index;
        cells.forEach(function(c) {
            c.updateCell(index, dim);
        });
    });

    o.propListener = o.renderer.addPropertyListener(["view"], function(view) {
        trigger.val(view);
    });

    return o.propListener;
};


module.exports = {
    NodeDistancePolicy: NodeDistancePolicy
};
