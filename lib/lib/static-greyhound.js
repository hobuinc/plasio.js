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

var Loader = function(baseURL) {
    // each loader needs a key
    this.baseURL = baseURL;
    this.key = "greyhoundstatic";
    this.stats = {totalBytes: 0};

    this.shouldDebugColor = false;
};

inherits(Loader, EventEmitter);

function getRGB(str){
    var hash = $.md5(str);
    var rgb = '#' + hash.substring(0,2) + hash.substring(2,4) + hash.substring(4,6);
    return rgb;
}

Loader.prototype.load = function(id, cb) {
    id = id.split(":")[1];

    var url = this.baseURL + "/" + id;
    var o = this;

    get(url, true, function(err, contentType, data) {
        if (err) return cb(err);
        var a = new Float32Array(data);
        var pointCount = a.length / 8;


        if (o.shouldDebugColor) {
            var c = [parseInt(id.substring(0, 2), 16),
                     parseInt(id.substring(2, 4), 16),
                     parseInt(id.substring(4, 6), 16)];

            for (var i = 0 ; i < pointCount ; i++) {
                a[8*i + 3] = c[0];
                a[8*i + 4] = c[1];
                a[8*i + 5] = c[2];
            }
        }

        return cb(null, a); 
    });
};

var Cell = function(renderer, allBBox, bbox, globalOffset, defaultStartDepth, maxDepthLevel) {
    this.renderer = renderer;
    this.bbox = bbox;
    this.worldBBox = bbox.offsetBy(globalOffset);

    this.gcenter = util.geocenter(this.worldBBox);
    
    this.baseDepth = (defaultStartDepth || 8);
    this.depth = this.baseDepth;

    this.maxDist = util.geodist(allBBox.mins, allBBox.maxs);
    this.maxDepthLevel = (maxDepthLevel || 12);

    // queue the base volume
    this.addBuffer({bbox: bbox, depthBegin: 0, depthEnd: this.baseDepth});
};

var hashSpecs = function(specs) {
    var s = JSON.stringify({
        mins: specs.bbox.mins, maxs: specs.bbox.maxs,
        depthBegin: specs.depthBegin,
        depthEnd: specs.depthEnd
    });

    var sha = createHash('sha1');
    sha.update(s);
    var h = sha.digest('hex');

    return h;
};

Cell.prototype.addBuffer = function(specs) {
    var id = "greyhoundstatic:" + hashSpecs(specs);
    this.renderer.addPointBuffer(id);
};

Cell.prototype.removeBuffer = function(specs) {
    var id = "greyhoundstatic:" + hashSpecs(specs);
    this.renderer.removePointBuffer(id);
};


var falloff = function(x, df) {
    // if x is very small, make sure its something valid
    if (Math.abs(x) < 0.0001)
        x = 0.00001 * Math.sign(x);

    // the falloff function is a blend of two functions, controlled by
    // the blending factor df
    //
    var f1 = 1 + Math.log(Math.max(0.00001, x - 0.01)) / 3;
    var f2 = 1 + Math.log(x);

    df = df * df * df;

    return f2 * df + f1 * (1 - df);
};

Cell.prototype.updateCell = function(eye, target) {
    var o = this;

    var et = vec3.distance(target, eye); // the distance between the eye and the target

    // df goes from 0 -> 1
    // when near the target, the value needs to be close to 0
    // when far from the target, the value needs to be close to 1
    //
    var df = util.clamp(et / o.maxDist, 0, 1); 
    var dist = util.geodist(this.gcenter, target);

    // figure out what the depth needs to be, see debug.js on more details about this
    //
    var dist_f = Math.min(1, dist / o.maxDist);
    
    /*
    var weight = falloff(dist_f, df);
    var h = Math.floor(o.baseDepth +
                       (o.maxDepthLevel - o.baseDepth) * (1 - weight)); 
     */


    var h = o.baseDepth + Math.ceil((o.maxDepthLevel - o.baseDepth) * (1 - dist_f));

    /*
    var h = Math.floor(o.baseDepth + (o.maxDepthLevel - o.baseDepth) * (1 - dist_f));
    if (h === o.depth)
        return; // nothing to do here

     */

    console.log("update-cell " + o.index + ":", o.depth, "->", h);
    
    while (o.depth > h) {
        var qr = {
            bbox: o.bbox,
            depthBegin: o.depth-1,
            depthEnd: o.depth
        };

        console.log("removing!");
        o.removeBuffer(qr);
        o.depth --;
    }

    while(o.depth < h) {
        var qa = {
            bbox: o.bbox,
            depthBegin: o.depth,
            depthEnd: o.depth + 1
        };

        o.addBuffer(qa);
        o.depth ++;
    }
};


var NodeDistancePolicy = function(renderer, baseURL) {
    this.renderer = renderer;
    this.baseURL = baseURL;
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

var get = function(url, binary, cb) {
    var r = new XMLHttpRequest();

    r.open("GET", url);
    if (binary)
        r.responseType = "arraybuffer";

    r.onload = function(e) {
        if (this.readyState === 4) {
            // this request is done
            if (this.status === 200)
                cb(null, this.getResponseHeader('content-type'), this.response);
            else
                cb(new Error("Unsuccessful error code: " + this.status));
        }
    };
    r.send();
};


var getJson = function(url, cb) {
    get(url, false, function(err, contentType, data) {
        if (err) return cb(err);

        if (!contentType.match(/^application\/json/))
            return cb(new Error("The recieved data type was not JSON, it was: " + contentType));

        return cb(null, JSON.parse(data.toString('utf-8')));
    });
};


NodeDistancePolicy.prototype.start = function() {
    var o  = this;

    // first things first, download the meta information file and see what we're dealing with
    //

    getJson(this.baseURL + "/meta.json", function(err, meta) {
        if (err) return console.log("There was an error trying to get meta information:", err);

        var bbox = new gh.BBox(meta.mins, meta.maxs);

        o.emit("bbox", bbox);

        var maxColorComponent = meta.maxColorComponent;
        var boxes = splitTillDepth(bbox, 2);

        console.log("Max color component:", maxColorComponent);
        o.renderer.setRenderOptions({
            maxColorComponent: maxColorComponent
        });

        var globalOffset = bbox.center();

        var cells = boxes.map(function(box, index) {
            var c = new Cell(o.renderer, bbox, box, globalOffset, 6, 12);
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

            var loc = cell.gcenter;

            console.log("Found cell location:", loc);

            cells.forEach(function(c) {
                c.updateCell(eye, loc);
            });
        });

        return o.renderer.addPropertyListener(["view"], function(view) {
            trigger.val(view);
        });
    });
};


module.exports = {
    NodeDistancePolicy: NodeDistancePolicy,
    Loader: Loader
};

