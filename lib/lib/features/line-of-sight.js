import { HeightmapCapture, randomId } from "../util";

var mat4 = require("gl-matrix").mat4;
var vec3 = require("gl-matrix").vec3;

var LineOfSight = function(renderer) {
    this.renderer = renderer;
    this.id = randomId("los");
};

var getTexture = function(buf, res) {
    var canvas = document.createElement('canvas');
    canvas.width = res;
    canvas.height = res;
    var context = canvas.getContext('2d');

    var img = context.createImageData(res, res);
    let woff = 0;

    for (let i = 0 ; i < buf.length ; i ++) {
        let alpha = buf[i] ? 0 : 200;

        img.data[woff] = 0;
        img.data[woff + 1] = 0;
        img.data[woff + 2] = 0;
        img.data[woff + 3] = alpha;

        woff += 4;
    }

    context.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
};

LineOfSight.prototype.getHeightMap = function(p, radius, res) {
    let hm = new HeightmapCapture(this.renderer);
    hm.captureForRadius(res, p, radius);
    return hm;
};

var indexAt = function(x, y, length) {
    return y * length + x;
};

var coordAt = function(xDist, yDist, xStep, yStep, start) {
    return {
        x: start.x + xDist * xStep + xStep / 2,
        y: start.y + yDist * yStep + yStep / 2
    };
};

var doQuadrant = function(
        p,
        heightmap,
        res,
        xSign,
        ySign,
        radius,
        slopes,
        output) {
    var diam = radius * 2;
    var xStart = (xSign > 0) ? radius : radius - 1;
    var yStart = (ySign > 0) ? radius : radius - 1;

    var xStep = diam * xSign / res;
    var yStep = diam * ySign / res;

    var elev, slope, current, index;
    var pre, alt, ratio, interp;
    var xDist, yDist, xNorm, yNorm;

    for (var y = yStart; Math.abs(y - yStart) < radius; y += ySign) {
        for (var x = xStart; Math.abs(x - xStart) < radius; x += xSign) {
            index = indexAt(x, y, diam);

            xDist = Math.abs(x - xStart);
            yDist = Math.abs(y - yStart);

            current = coordAt(xDist, yDist, xStep, yStep, p);

            elev = heightmap[index] - p.z;
            slope = elev / Math.sqrt(
                    Math.pow((current.x - p.x), 2) +
                    Math.pow((current.y - p.y), 2));

            if (y != yStart) {
                // Off of nominal x-axis.
                pre = slopes[indexAt(x != xStart ? x - xSign : x, y - ySign, diam)];

                xNorm = Math.abs(x - xStart);
                yNorm = Math.abs(y - yStart);

                if (xNorm > yNorm) {
                    // Nearer to x-axis.
                    alt = slopes[indexAt(x - xSign, y, diam)];
                    ratio = (xDist * (yDist - ySign) / yDist) % 1;

                    var max = Math.max(pre, alt);
                    if (max != Number.NEGATIVE_INFINITY) {
                        if (Math.min(pre, alt) != Number.NEGATIVE_INFINITY) {
                            // Both pre and alt are valid.
                            interp = pre + (alt - pre) * ratio;
                        }
                        else interp = max;  // One of them is -Inf.
                    }
                    else interp = Number.NEGATIVE_INFINITY; // Both are -Inf.
                }
                else if (xNorm < yNorm) {
                    // Nearer to y-axis.
                    alt = slopes[indexAt(x, y - ySign, diam)];
                    ratio = (xDist * (xDist - xSign) / yDist) % 1;

                    var max = Math.max(pre, alt);
                    if (max != Number.NEGATIVE_INFINITY) {
                        if (Math.min(pre, alt) != Number.NEGATIVE_INFINITY) {
                            // Both pre and alt are valid.
                            interp = pre + (alt - pre) * ratio;
                        }
                        else interp = max;  // One of them is -Inf.
                    }
                    else interp = Number.NEGATIVE_INFINITY; // Both are -Inf.
                }
                else {
                    interp = pre;
                }

                if (Math.abs(heightmap[index]) < .00001) {
                    slope = Number.NEGATIVE_INFINITY;
                    output[index] =
                        xNorm == yNorm ? output[indexAt(x - xSign, y - ySign, diam)] :
                        (xNorm > yNorm) ?
                            output[indexAt(x - xSign, y, diam)] :
                            output[indexAt(x, y - ySign, diam)];
                }
                else {
                    output[index] = slope >= interp;
                }

                slopes[index] = Math.max(slope, interp);
            }
            else {
                // On x-axis.
                if (x != xStart) {
                    // Off of y-axis.
                    if (Math.abs(heightmap[index]) > .00001) {
                        pre = slopes[indexAt(x - xSign, y, diam)];

                        output[index] = slope >= pre;
                        slopes[index] = Math.max(slope, pre);
                    }
                    else {
                        slopes[index] = slopes[indexAt(x - xSign, y, diam)];
                        output[index] = output[indexAt(x - xSign, y, diam)];
                    }
                }
                else {
                    // Origin point.
                    slopes[index] = (Math.abs(heightmap[index]) > 0.00001) ? slope : Number.NEGATIVE_INFINITY;
                    output[index] = 1;

                }
            }
        }
    }
};

LineOfSight.prototype.go = function(origin, radius) {
    // XZY due to renderer's view of the world.
    var p = { x: origin[0], z: origin[1], y: origin[2] };

    var diam = radius * 2;
    var res = diam;

    var heightmap = this.getHeightMap(origin, radius, res);

    var essBuf = new ArrayBuffer(res * res * 4);
    var slopes = new Float32Array(essBuf);

    var binBuf = new ArrayBuffer(res * res);
    var output = new Int8Array(binBuf);

    for (var i = -1; i <= 1; i += 2) {
        for (var j = -1; j <= 1; j += 2) {
            doQuadrant(p, heightmap.rawData, res,  i,  j, radius, slopes, output);
        }
    }

    var bounds = [p.x - radius, p.y - radius, p.x + radius, p.y + radius];
    output = getTexture(output, res);

    var image = new Image();
    var o = this;
    image.onload = function() {
        o.renderer.addOverlay(o.id, bounds, image);
    };

    image.crossOrigin = '';
    image.src = output;
};

LineOfSight.prototype.resetState = function() {
    this.renderer.removeOverlay(this.id);
}

module.exports = {
    LineOfSight: LineOfSight
};

