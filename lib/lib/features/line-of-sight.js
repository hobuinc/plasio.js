var mat4 = require("gl-matrix").mat4;
var vec3 = require("gl-matrix").vec3;

var losId = 'line-of-sight-overlay';
var visible = 'rgba(0,0,0,0)';
var occluded = 'rgba(0,0,0,.8)';

var LineOfSight = function(renderer) {
    this.renderer = renderer;
}

var getTexture = function(buf, res) {
    var canvas = document.createElement('canvas');
    canvas.width = res;
    canvas.height = res;
    var context = canvas.getContext('2d');

    for (var i = 0; i < res * res; ++i) {
        var scale = 0;

        var x = Math.floor(i % res);
        var y = Math.floor(i / res);

        context.fillStyle = buf[i] ? visible : occluded;
        context.fillRect(x, y, 1, 1);
    }

    context.stroke();
    return canvas.toDataURL('image/png');
}

LineOfSight.prototype.getHeightMap = function(p, radius, res) {
    var view = mat4.identity(mat4.create());
    mat4.rotateZ(view, view, 3.14159265);
    mat4.rotateX(view, view, 1.5705);

    var wlower = [p.x - radius, p.z - radius, p.y - radius];
    var wupper = [p.x + radius, p.z + radius, p.y + radius];

    var lower = vec3.transformMat4(vec3.create(), wlower, view);
    var upper = vec3.transformMat4(vec3.create(), wupper, view);

    var topDownProjection = mat4.ortho(
            mat4.create(),
            lower[0], upper[0],
            upper[1], lower[1],
            -10000, 10000);

    var proj = mat4.multiply(mat4.create(), topDownProjection, view);

    return this.renderer.projectToImage(proj, 2, res);
}

var indexAt = function(x, y, length) {
    return y * length + x;
}

var coordAt = function(xDist, yDist, xStep, yStep, start) {
    return {
        x: start.x + xDist * xStep + xStep / 2,
        y: start.y + yDist * yStep + yStep / 2
    };
}

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
                pre = slopes[indexAt(x - xSign, y - ySign, diam)];

                xNorm = Math.abs(x - xStart);
                yNorm = Math.abs(y - yStart);

                if (xNorm > yNorm) {
                    // Nearer to x-axis.
                    alt = slopes[indexAt(x - xSign, y, diam)];
                    ratio = (xDist * (yDist - ySign) / yDist) % 1;
                    interp = pre + (alt - pre) * ratio;
                }
                else if (xNorm < yNorm) {
                    // Nearer to y-axis.
                    alt = slopes[indexAt(x, y - ySign, diam)];
                    ratio = (xDist * (xDist - xSign) / yDist) % 1;
                    interp = alt + (pre - alt) * ratio;
                }
                else {
                    // On a diagonal.
                    interp = pre;
                }

                if (Math.abs(heightmap[index]) < .00001) {
                    slope = Number.NEGATIVE_INFINITY;
                    output[index] =
                        output[indexAt(x - xSign, y - ySign, diam)] ||
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
                    slopes[index] = slope;
                    output[index] = 1;
                }
            }
        }
    }
}

LineOfSight.prototype.go = function(origin, radius) {
    // XZY due to renderer's view of the world.
    var p = { x: origin[0], z: origin[1], y: origin[2] };

    var diam = radius * 2;
    var res = diam;

    var heightmap = this.getHeightMap(p, radius, res);

    var essBuf = new ArrayBuffer(res * res * 4);
    var slopes = new Float32Array(essBuf);

    var binBuf = new ArrayBuffer(res * res);
    var output = new Int8Array(binBuf);

    for (var i = -1; i <= 1; i += 2) {
        for (var j = -1; j <= 1; j += 2) {
            doQuadrant(p, heightmap, res,  i,  j, radius, slopes, output);
        }
    }

    var bounds = [p.x - radius, p.y - radius, p.x + radius, p.y + radius];
    var output = getTexture(output, res);

    var image = new Image();
    var o = this;
    image.onload = function() {
        o.renderer.addOverlay(losId, bounds, image);
    };

    image.crossOrigin = '';
    image.src = output;
}

LineOfSight.prototype.resetState = function() {
    this.renderer.removeOverlay(losId);
}

module.exports = {
    LineOfSight: LineOfSight
};

