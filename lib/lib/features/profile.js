// profile.js
// A profile creator, needs the renderer to query stuff
//

var mat4 = require("gl-matrix").mat4;
var vec3 = require("gl-matrix").vec3;


var Profiler = function(renderer) {
    this.renderer = renderer;
};


var colormap

Profiler.prototype.profileLines = function(lines, bbox, res) {
    // compute the largest bounds that will encompass this range
    var mins = [9999999999999999999999999,
                9999999999999999999999999,
                9999999999999999999999999],
        maxs = [-9999999999999999999999999,
                -9999999999999999999999999,
                -9999999999999999999999999];
    
    // our view matrix for ortho projections, basically look straight down
    //
    var view = mat4.identity(mat4.create());
    mat4.rotateZ(view, view, -1.5705);; // make sure we're heading north
    mat4.rotateX(view, view, 1.5705);; // rotate 90deg around X, look straight down
    //mat4.translate(view, view, [0, 0, -dist]); // move back some considerable distance

    var centerx = bbox[0] + (bbox[3] - bbox[0]) / 2,
        centery = bbox[1] + (bbox[4] - bbox[1]) / 2,
        centerz = bbox[2] + (bbox[5] - bbox[2]) / 2;

    var zrange = bbox[5] - bbox[2];

    lines.forEach(function(l) {
        var s = l[0], e = l[1];

        console.log("line:", s[0], s[1], s[2], "-->", e[0], e[1], e[2]);
    });

    var p = function(v) {
        var x = v[0], y = v[1], z = v[2];

        mins[0] = Math.min(mins[0], x);
        mins[1] = Math.min(mins[1], y);
        mins[2] = Math.min(mins[2], z);

        maxs[0] = Math.max(maxs[0], x);
        maxs[1] = Math.max(maxs[1], y);
        maxs[2] = Math.max(maxs[2], z);
    };

    lines.forEach(function(line) {
        // each point is in world coordinate space, for our ortho
        // projection to make sense the point should be representated in the same
        // coordinate space as "view".
        //
        var start = line[0];
        var end   = line[1];

        // now figure mins and maxes in this coordinate space
        //
        p(start);
        p(end);
    });

    console.log("mins:", mins, "maxs:", maxs);

    // what are the ranges of mins and maxs
    var rx = maxs[0] - mins[0],
        ry = maxs[1] - mins[1],
        rz = maxs[2] - mins[2];

    console.log("ranges:", rx, ry, rz);

    // determine our center of where the region of interest is, this is the center of
    // our ortho projection
    var cx = mins[0] + rx / 2,
        cy = mins[1] + ry / 2,
        cz = mins[2] + rz / 2;

    console.log("center:", cx, cy, cz);

    // chosen range is the max of the two
    var cr = Math.max(rx, ry, rz),
        cr2 = cr / 2;

    // now determine the two planes
    var lower = [cx + cr2, cy - cr2, cz - cr2],
        upper = [cx - cr2, cy + cr2, cz + cr2];

    console.log("lower:", lower, " upper:", upper);
    // now transform themes
    lower = vec3.transformMat4(lower, lower, view);
    upper = vec3.transformMat4(upper, upper, view);

    console.log("transformed lower:", lower, " upper:", upper);

    

    // establish our view matrix
    var topDownProjection = mat4.ortho(mat4.create(),
                                       lower[0], upper[0],
                                       lower[1], upper[1],
                                       -10000, 10000);
                                       

    //var dist = 1000.0; // TODO, this should come from the range somewhere, higher than the highest thing
    /*
    var view = mat4.identity(mat4.create());
    //mat4.rotateY(view, view, -1.5705);; // make sure we're heading north
    mat4.rotateX(view, view, -1.5705);; // rotate 90deg around X, look straight down
    mat4.translate(view, view, [0, 0, -dist]); // move back some considerable distance
     */
    
    var proj = mat4.multiply(mat4.create(), topDownProjection, view);
    // ask renderer to do the projection for us
    //
    res = res || 256;
    var buf = this.renderer.projectToImage(proj, 2, res);

    var canvas = document.createElement("canvas");
    canvas.width = res;
    canvas.height = res;

    canvas.style.cssText = "position:absolute;left:0px;top:0px;";

    var ctx = canvas.getContext("2d");

    // note that since viewport is origined at bottom, left, our image here is upside down
    console.log(buf);
    console.log(centerz, zrange);
    var colormap = ['rgb(158,1,66)','rgb(213,62,79)','rgb(244,109,67)','rgb(253,174,97)','rgb(254,224,139)','rgb(255,255,191)','rgb(230,245,152)','rgb(171,221,164)','rgb(102,194,165)','rgb(50,136,189)','rgb(94,79,162)', 'rgb(84,48,5)','rgb(140,81,10)','rgb(191,129,45)','rgb(223,194,125)','rgb(246,232,195)','rgb(245,245,245)','rgb(199,234,229)','rgb(128,205,193)','rgb(53,151,143)','rgb(1,102,94)','rgb(0,60,48)'];

    for (var i = 0, il = res * res ; i < il ; i ++) {
        var r = -1;

        if (Math.abs(buf[i]) > 0.00001) { // may be something valid
            var cc = ((buf[i] + centerz) / zrange);
            r = Math.floor(cc * 255.0);
        }

        var row = Math.floor(i / res);
        var col = Math.floor(i % res);

        var c = "";
        if (r === -1)
            c = "#000";
        else {
            var step = Math.floor(255 / colormap.length);
            var index = Math.floor(r / step);
            c = colormap[index];
        }

        ctx.fillStyle = c;
        ctx.fillRect(row, res-col, 1, 1);
    }


    document.body.appendChild(canvas);

};

module.exports = {
    Profiler: Profiler
};
