// debug.js
// Debug policy and loader
//

var BBox = require("greyhound.js").BBox;
var vec3 = require("gl-matrix").vec3;
var EventEmitter = require("events").EventEmitter;

var geocenter = function(bbox) {
    // get the center of the box and then transform it into our
    // coordinate space
    //
    var center = [bbox.mins[0] + (bbox.maxs[0] - bbox.mins[0]) / 2,
                  bbox.mins[1] + (bbox.maxs[1] - bbox.mins[1]) / 2,
                  bbox.mins[2] + (bbox.maxs[2] - bbox.mins[2]) / 2];

    // now transform it
    return [-center[0], center[2], center[1]];
};

var geodist = function(a, b) {
    return vec3.distance([a[0], 0, a[2]],
                         [b[0], 0, b[2]]);
    
};



var makeid = function(b) {
    return "debug:" + JSON.stringify({h: b.height, n: b.mins, x: b.maxs});
};

var decodeid = function(id) {
    var b = JSON.parse(id.substr(6));
    console.log("decoded:", b);
    var bbx = new BBox(b.n, b.x);
    bbx.height = b.h;
    
    return bbx;
};

var blend = (function() {
    var c = [0, 0, 0],
        c1 = [0, 0, 0],
        c2 = [0, 0, 0];
    
    return function(s, e, f) {
        console.log(f);
        return vec3.add(c,
                        vec3.scale(c1, s, 1 - f),
                        vec3.scale(c2, e, f));
    };
})();

var genDebugBuffer = function(bbox) {
    // generate a debug buffer in the bound box
    // each point is 3 (xyz), 3 (rgb) and 2 (intensity + class)
    //
    var points = 10;
    
    var pnts = new Float32Array(32 * points * points);
    var pc = 0;
    var c = blend([1, 0, 0], [0, 1, 0], bbox.height / 16);
    for (var y = 0 ; y < points ; y ++) {
        for(var x = 0; x < points ; x++) {
            var fx = x / points,
                fy = y / points;

            pnts[pc++] = bbox.mins[0] + (bbox.maxs[0] - bbox.mins[0]) * fx;
            pnts[pc++] = bbox.mins[1] + (bbox.maxs[1] - bbox.mins[1]) * fy;
            pnts[pc++] = 0;

            pnts[pc++] = c[0];
            pnts[pc++] = c[1];
            pnts[pc++] = c[2];

            pnts[pc++] = 0;
            pnts[pc++] = 0;
        }
    }

    return pnts;
};


var Loader = function() {
    this.key = "debug";
};

Loader.prototype.load = function(id, cb) {
    // load a debug buffer using the given ID
    //
    var b = decodeid(id);

    var o = this;
    setTimeout(function() {
        cb(null, genDebugBuffer(b));
    });
};


var splitTillDepth = function(bbox, depth) {
    var split = function(b, d) {
        console.log(b);
        var bxs = b.splitQuad();
        if (depth === d) return bxs;

        return [].concat(split(bxs[0], d + 1),
                         split(bxs[1], d + 1),
                         split(bxs[2], d + 1),
                         split(bxs[3], d + 1));
    };

    return split(bbox, 1);
};

var NodeDistancePolicy = function(renderer) {
    this.renderer = renderer;
    var size = 1000;
    
    var h = size / 2;

    this.bbox = new BBox([-h, -h, -h], [h, h, h]);
    this.boxes = splitTillDepth(this.bbox, 3).map(function(b) {
        b.height = 0;
        return b;
    });

    this.maxDist = Math.sqrt(size * size + size * size);
};


NodeDistancePolicy.prototype.start = function() {
    // start node distance policy
    var o = this;

    o.renderer.setRenderOptions({
        maxColorComponent: 1.0
    });

    var e = new EventEmitter();

    setTimeout(function() {
        e.emit("bbox", o.bbox);
    });

    var falloff = function(x) {
        // if x is very small, make sure its something valid
        if (Math.abs(x) < 0.0001)
            x = 0.00001 * Math.sign(x);

        return Math.max(Math.min((Math.log(x*x*x) + 10) * 5, 1.0), 0.0);
    };
    


    this.renderer.addPropertyListener(["view", "target"], function(target) {
        if (!target)
            return;
        
        o.boxes.forEach(function(b) {
            // update current box based on distance
            var dist = geodist(target, geocenter(b));
            // dist_f is always between 0 and 1, 0 indicating that its close
            // to us, while 1 means that its far enough that we don't care anymore
            // how far it is
            //
            var dist_f = Math.min(1, dist / o.maxDist);

            // we can change the dist_f to better suit our needs for DOF fall off
            //
            dist_f = falloff(dist_f);

            // h tells us the level of detail ranging from 16 to 0.
            var h = Math.floor(16 * Math.max(1.0 - dist_f, 0));

            if (h !== b.height) {
                // the height need to be adjusted
                o.renderer.removePointBuffer(makeid(b));

                b.height = h;
                o.renderer.addPointBuffer(makeid(b));
            }
        });
    });

    return e;
};

module.exports = {
    Loader: Loader,
    NodeDistancePolicy: NodeDistancePolicy
};

