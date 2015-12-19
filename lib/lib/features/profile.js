// profile.js
// A profile creator, needs the renderer to query stuff
//

import { mat4, vec3 } from "gl-matrix";
import async from "async";

import { joinFloatBuffers } from "../util";


// Takes an array of results, merges the buffers, and maintains the stats
//
let mergeResults = (res) => {
    let reduceStats = (name, fn) => {
        return res.reduce((sofar, buf) => {
            let s = buf[name];

            sofar[0] = fn(sofar[0], s[0]);
            sofar[1] = fn(sofar[1], s[1]);
            sofar[2] = fn(sofar[2], s[2]);

            return sofar;
        }, [0, 0, 0]);
    };

    return {
        buffer: joinFloatBuffers(res.map(r => r.buffer)),
        mins: reduceStats("mins", Math.min),
        maxs: reduceStats("maxs", Math.max),
        totalPoints: res.reduce((sum, r) => sum + r.totalPoints, 0),
        colorMaxs: reduceStats("colorMaxs", Math.max)
    };
};


export class Profiler {
    // Accepts a renderer and the list of segments to profile against and the desired width.
    // Segments are expected to be in pairs [start, end] in the world coordinate system and
    // not the point cloud coordinate system (which also means that they are expected to be normalized).
    //
    constructor(renderer, segments, width, fullPointCloudBBox) {
        this.renderer = renderer;
        this.segments = segments;
        this.width = width;
        this.pointBBox = fullPointCloudBBox;
    }

    // Returns an array buffer with the entire profile extracted from the renderer point buffers
    // The points coordinates are the same as how they were fetched from the server (normalized
    // or non-normalized.
    //
    // rotateForX controls whether we want to extract raw points or whether we want to rotate them to match
    // the X axis, left to right, e.g. if the profile segment runs over the Z axis from -10Z to +10Z then
    // this flag will cause all points to rotate by 90 degrees.  This is done so that all points are oriented
    // the same way and are easier to display
    //
    // The value is returned through a callback since the profiler may spawn web workers or do tasked
    // execution
    //
    extractProfile(rotateForX, cb) {
        let profiles = [];
        let buffers = this.renderer.getLoadedBuffers();

        let doSingleProfile = (v, cb1) => {
            this._extractProfile(buffers, v, this.width, cb1);
        };

        // go over each one, one at a time and call cb when done.
        async.map(this.segments, doSingleProfile, (err, res) => {
            if (err) return cb(err);
            if (!rotateForX) return cb(null, res);

            let offsets = [];
            this.segments.reduce((offset, [start, end]) => {
                offsets.push(offset);
                return offset + vec3.length(start, end);
            }, 0);

            let tasks = res.map((r, i) => [r, this.segments[i], offsets[i]]);

            // time to rotate points and line them up
            async.map(tasks, ([buf, segment, offset], cb) => {
                this._lineupBuffer(buf, segment, offset, cb);
            }, cb);
        });
    }

    _lineupBuffer(buf, [start, end], offset, cb) {
        console.log(buf, start, end, offset);
        console.log(buf.mins.toString(), buf.maxs.toString());

        if (buf.totalPoints === 0) {
            return cb(null, buf);
        }


        // to translate the points the right way we need to:
        // 1. Bring the points down to the origin (start point)
        // 2. Rotate them around the Y axis so that the strip is going down the X axis
        // 3. Apply a translation to move the points off by the given offset
        // 4. Apply the same transformation to the mins and maxs.

        // translation to bring points to the origin
        //
        let trans1 = mat4.identity(mat4.create());
        mat4.translate(trans1, trans1, [-start[0], -start[1], -start[2]]);

        console.log(trans1);

        // rotation to rotate around the Y axis
        //
        // figure out the orientation of the segment
        let dir = vec3.subtract(vec3.create(), end, start);
        vec3.normalize(dir, dir);

        // get the angle or rotation required to match up with the X axis
        let rotationAngle = Math.acos(vec3.dot([1, 0, 0], dir));

        // setup the rotation matrix, rotate by rotationAngle around the Y axis
        let matRot = mat4.identity(mat4.create());
        mat4.rotateY(matRot, matRot, rotationAngle);

        console.log(matRot);

        // setup translation to move the points offset distance from the origin
        let trans2 = mat4.identity(mat4.create());
        mat4.translate(trans2, trans2, [offset, 0, 0]);

        console.log(trans2);

        // combine transforms: trans2 * matRot * trans1
        let matTransform = mat4.multiply(mat4.create(), mat4.multiply(mat4.create(), trans2, matRot), trans1);

        // now transform all points
        let inbuf = buf.buffer;
        let off = 0;
        let sizeInFloats = inbuf.length / buf.totalPoints;

        let v = vec3.create();

        for (let i = 0, il = buf.totalPoints ; i < il ; i ++) {
            vec3.set(v, inbuf[off], inbuf[off + 1], inbuf[off + 2]);
            if (i < 10) {
                console.log(v[0], v[1], v[2]);
            }

            vec3.transformMat4(v, v, matTransform);

            if (i < 10) {
                console.log(v[0], v[1], v[2]);
            }

            // store it back
            inbuf[off] = v[0];
            inbuf[off+1] = v[1];
            inbuf[off+2] = v[2];

            off += sizeInFloats;
        }

        // transform the mins and maxs
        vec3.transformMat4(buf.mins, buf.mins, matTransform);
        vec3.transformMat4(buf.maxs, buf.maxs, matTransform);

        console.log("Done:", buf);
        console.log(buf.mins.toString(), buf.maxs.toString());

        cb(null, buf);
    }

    _extractProfile(buffers, [start, end], width, cb) {
        // extract profile for the given vector alone and call cb when done
        //
        let tolerance = width;

        // figure out the needed vectors: up, dir and right along with normalized dir
        let up = [0, 1, 0];
        let dir = vec3.subtract(vec3.create(), end, start);
        let ndir = vec3.normalize(vec3.create(), dir);

        let right = vec3.cross(vec3.create(), ndir, up);

        // figure out the plane which we will use to find points within tolerance
        // on either side of the vector
        //
        let plane = [right[0], right[1], right[2], -vec3.dot(start, right)];

        // figure out the plane which we will use to find points within start and end points
        // along the vector
        let mid = vec3.lerp(vec3.create(), start, end, 0.5);
        let planeHalf = [ndir[0], ndir[1], ndir[2], -vec3.dot(mid, ndir)];

        // the half length of this vector
        let halfLength = vec3.length(dir) * 0.5;

        let doSingleBuffer = (b, cb1) => {
            this._extractInRangePointsFromBuffer(b, plane, planeHalf, tolerance, halfLength, cb1);
        };

        async.map(buffers, doSingleBuffer, function(err, bufs) {
            // bail if error
            if (err)
                return cb(err);

            // combine all buffers
            let finalResult = mergeResults(bufs);
            cb(null, finalResult);
        });
    }

    _isOfInterest (mins, maxs, plane, planeHalf, tolerance, halfLength) {
        // check if this box (mins->maxs) is of interest to us, basically if it intersects with
        // our region of interest

        let intersectsPlane = (plane, tol) => {
            let [nx, ny, nz, d] = plane;
            // determine the p vertex
            var p = [mins[0], mins[1], mins[2]];
            if (nx >= 0.0) p[0] = maxs[0];
            if (ny >= 0.0) p[1] = maxs[1];
            if (nz >= 0.0) p[2] = maxs[2];

            // determine the n vertex
            var n = [maxs[0], maxs[1], maxs[2]];
            if (nx >= 0.0) n[0] = mins[0];
            if (ny >= 0.0) n[1] = mins[1];
            if (nz >= 0.0) n[2] = mins[2];

            // figure distance to p
            let pdist = vec3.dot(plane, p) + d;
            if (pdist < -tol) {
                // totally out in the negative space
                return false;
            }

            let ndist = vec3.dot(plane, n) + d;
            if (ndist > tol) {
                // again totally out in positive space
                return false;
            }

            // within range
            return true;
        };

        return intersectsPlane(plane, tolerance) && intersectsPlane(planeHalf, halfLength);
    }

    _extractInRangePointsFromBuffer(buffer, plane, planeHalf, tolerance, halfLength, cb) {
        // check if buffer qualifies for testing, note that the mins and maxs are in world space and so is everything
        // else, only the actual point values are determined by the normalization flag
        //
        let needsCheck = this._isOfInterest(buffer.mins, buffer.maxs, plane, planeHalf, tolerance, halfLength);
        if (!needsCheck) {
            return cb(null, {
                mins: [Infinity, Infinity, Infinity],
                maxs: [-Infinity, -Infinity, -Infinity],
                colorMaxs: [0, 0, 0],
                totalPoints: 0,
                buffer: new Float32Array()
            });
        }


        // TODO: for non-normalized space
        //let center = this.pointBBox.center();
        let center = [0, 0, 0];

        let isAcceptable = (pt) => {
            let dist1 = vec3.dot(plane, pt) + plane[3];
            if (Math.abs(dist1) > tolerance) // too far from plane 1
                return false;

            let dist2 = vec3.dot(planeHalf, pt) + planeHalf[3];
            return Math.abs(dist2) < halfLength; // acceptable only if also in range for half plane
        };

        let collectPoints = (buffer, startIndex, count, cb) => {
            let rawBuf = buffer.data,
                sizeInFloats = buffer.stride / 4;

            let outBuffer = new Float32Array(rawBuf.length); // preallocate for all to qualify, we'll strip it later
            let woff = 0, roff = 0;

            let mins = [Infinity, Infinity, Infinity],
                maxs = [-Infinity, -Infinity, -Infinity],
                col = [0, 0, 0];

            for (var i = startIndex, il = startIndex + count ; i < il ; i ++) {
                let x = rawBuf[roff + 0],
                    y = rawBuf[roff + 1],
                    z = rawBuf[roff + 2];

                // adjust the coordinate space of the points if they are not normalized
                if (!buffer.normalized) {
                    x -= center[0];
                    y -= center[1];
                    z -= center[2];
                }

                if (isAcceptable([x, y, z])) {
                    mins[0] = Math.min(mins[0], x);
                    mins[1] = Math.min(mins[1], y);
                    mins[2] = Math.min(mins[2], z);

                    maxs[0] = Math.max(maxs[0], x);
                    maxs[1] = Math.max(maxs[1], y);
                    maxs[2] = Math.max(maxs[2], z);

                    col[0] = Math.max(col[0], rawBuf[roff + 3]);
                    col[1] = Math.max(col[1], rawBuf[roff + 4]);
                    col[2] = Math.max(col[2], rawBuf[roff + 5]);

                    for (let j = 0 ; j < sizeInFloats ; j ++) {
                        outBuffer[woff + j] = rawBuf[roff + j];
                    }
                    woff += sizeInFloats;
                }


                roff += sizeInFloats;
            }

            let out = new Float32Array(woff);
            out.set(outBuffer.subarray(0, woff), 0);

            cb(null, {
                buffer: out,
                mins: mins,
                maxs: maxs,
                totalPoints: out.length / sizeInFloats,
                colorMaxs: col
            });
        };

        let createTasks = (total, perstep) => {
            let tasks = [];
            let totalPoints = buffer.totalPoints;
            let off = 0;

            while(totalPoints > 0) {
                tasks.push([off, Math.min(POINTS_PER_STEP, totalPoints)]);
                totalPoints -= POINTS_PER_STEP;
                off += POINTS_PER_STEP;
            }

            return tasks;
        };

        let POINTS_PER_STEP = 10000;

        let tasks = createTasks(buffer.totalPoints, POINTS_PER_STEP);

        async.map(tasks, ([start, count], cb) => {
            collectPoints(buffer, start, count, cb);
        }, (err, res) => {
            let finalResult = mergeResults(res);
            cb(null, finalResult);
        });
    }
}


/*
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
*/
