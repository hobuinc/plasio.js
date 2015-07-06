// profile.js
// A profile creator, needs the renderer to query stuff
//

var mat4 = require("gl-matrix").mat4;
var vec3 = require("gl-matrix").vec3;

var HeightmapCapture = require("../util").HeightmapCapture;


var Profiler = function(renderer) {
    this.renderer = renderer;
};

Profiler.showDebuggingBuffers = false;

var addDebuggerCanvas = function(hm, res, centerz, zrange, ls) {
    var canvas = document.createElement("canvas");
    canvas.width = res;
    canvas.height = res;

    canvas.style.cssText = "position:absolute;left:0px;top:0px;";

    var ctx = canvas.getContext("2d");

    // note that since viewport is origined at bottom, left, our image here is upside down
    var colormap = ['rgb(158,1,66)','rgb(213,62,79)','rgb(244,109,67)','rgb(253,174,97)',
                    'rgb(254,224,139)','rgb(255,255,191)','rgb(230,245,152)','rgb(171,221,164)',
                    'rgb(102,194,165)','rgb(50,136,189)','rgb(94,79,162)', 'rgb(84,48,5)',
                    'rgb(140,81,10)','rgb(191,129,45)','rgb(223,194,125)','rgb(246,232,195)',
                    'rgb(245,245,245)','rgb(199,234,229)','rgb(128,205,193)','rgb(53,151,143)',
                    'rgb(1,102,94)','rgb(0,60,48)'];

    for (var i = 0, il = res * res ; i < il ; i ++) {
        var r = -1;

        var row = Math.floor(i / res);
        var col = Math.floor(i % res);

        var val = hm.readPixel(col, row);
        var c= "";
        if (val === 0.0)
            c = "#000";
        else {
            val += 512;
            val /= 2;
            
            var step = Math.floor(255 / colormap.length);
            var index = Math.floor(val / step);
            var c = colormap[index];
        }

        ctx.fillStyle = c;
        ctx.fillRect(col, row, 1, 1);
    }


    // draw our scaled lines on top of this
    ctx.strokeStyle = "red";
    ctx.lineWidth = 5.0;

    ls.forEach(function(l) {
        var start = l[0],
            end = l[1];

        ctx.moveTo(start[0], start[1]);
        ctx.lineTo(end[0], end[1]);
    });

    ctx.stroke();
    document.body.appendChild(canvas);

    return canvas;
};


Profiler.prototype.profileLines = function(lines, bbox, res) {
    // compute the largest bounds that will encompass this range
    var l = Math.min(), h = Math.max();

    var mins = [l, l, l],
        maxs = [h, h, h];

    console.log("profiler region bounds:", bbox);

    var zrange = bbox[5] - bbox[2];

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

    res = res || 128;

    // what are the ranges of mins and maxs
    var rx = maxs[0] - mins[0],
        ry = maxs[1] - mins[1],
        rz = maxs[2] - mins[2];

    console.log("ranges:", rx, ry, rz);

    var hm = new HeightmapCapture(this.renderer);
    hm.captureForRadius(res,
                        [mins[0] + rx / 2, mins[1] + ry / 2, mins[2] + rz / 2],
                        Math.max(rx, ry, rz) / 2);


    var scaledLines = lines.map(function(l) {
        var start = l[0];
        var end   = l[1];

        // determine the starts and ends in the coordinate space of the projected image
        //
        start = hm.worldCoordinatesToPixel(start);
        end = hm.worldCoordinatesToPixel(end);

        return [start, end];
    });


    // such debugger, when uncommented, it shows the canvas view of what we're picking and what we're
    // reading back, pixVal has a line that a needs to be uncommented in case read tracking is needed
    //
    var debugCanvas = null;
    var debugCtx = null;
    if (Profiler.showDebuggingBuffers) {
        debugCanvas = addDebuggerCanvas(hm, res, 0, zrange, scaledLines);
        debugCtx = debugCanvas.getContext("2d");
    }

    // read the lines out
    //
    var pixVal = function(x, y) {
        var col = Math.floor(x);
        var row = Math.floor(y);

        // The line below is the read tracking line

        if (debugCtx) {
            debugCtx.fillStyle = "yellow";
            debugCtx.fillRect(col-1, row-1, 2, 2);
        }

        return hm.readPixel(col, row);
    };

    var lineSamples = scaledLines.map(function(l) {
        var s = l[0],
            e = l[1];

        // All coordinates here are in image space
        // read stuff in on the lines
        var samples = [];

        var x0 = Math.floor(s[0]), y0 = Math.floor(s[1]),
            x1 = Math.floor(e[0]), y1 = Math.floor(e[1]);

        var dx = Math.abs(x1 - x0),
            dy = Math.abs(y1 - y0);

        var sdx = (x1 - x0) < 0 ? -1 : 1,
            sdy = (y1 - y0) < 0 ? -1 : 1;

        var x, y, f;

        if (dx > dy) {
            // more horizontal than vertical
            for (x = 0 ; x <= dx ; x ++) {
                f = x / dx;
                y = y0 + sdy * dy * f;

                samples.push(pixVal(x0 + sdx * x, y));
            }
        }
        else {
            // more horizontal than vertical
            for (y = 0 ; y <= dy ; y ++) {
                f = y / dy;
                x = x0 + sdx * dx * f;
                samples.push(pixVal(x, y0 + sdy * y));
            }
        }

        var zadjust = (bbox[5] - bbox[2]) / 2;

        // make sure the z is correctly offset by our centerz
        return samples.map(function(s) {
            if (Math.abs(s) < 0.000001)
                return 0;
            return s + zadjust;
        });
    });

    return lineSamples;
};

module.exports = {
    Profiler: Profiler
};
