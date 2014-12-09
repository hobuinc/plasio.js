// util.js
// much wow utility functions
//

var vec3 = require("gl-matrix").vec3;

var clamp = function(v, n, x) {
    return Math.min(x, Math.max(v, n));
};

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

var TriggeredDispatch = function(to, cb) {
    this.to = to;
    this.cb = cb;
    this.timer = null;
    this.v = undefined;
};

TriggeredDispatch.prototype.val = function(v) {
    this.v = v;
    
    if (this.timer !== null) {
        // there is an active timer, clear it out
        clearTimeout(this.timer);
        this.timer = null;
    }

    console.log(this.v);


    if (this.v !== undefined) {
        var o = this;
        this.timer = setTimeout(function() {
            o.timer = null;

            console.log("trigger!!");

            process.nextTick(o.cb.bind(null, o.v));
        }, this.to);
    }
};




module.exports = {
    clamp: clamp,
    geocenter: geocenter,
    geodist: geodist,
    TriggeredDispatch: TriggeredDispatch
};
