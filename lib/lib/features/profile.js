// profile.js
// A profile creator, needs the renderer to query stuff
//

import { mat4, vec3 } from "gl-matrix";
import async from "async";

import { joinFloatBuffers } from "../util";


// Takes an array of results, merges the buffers, and maintains the stats
//
let mergeResults = (res) => {

    let mins = [Infinity, Infinity, Infinity],
        maxs = [-Infinity, -Infinity, -Infinity],
        cols = [0, 0, 0],
        totalPoints = 0;

    let fx = (fn, a, b) => {
        return [
            fn(a[0], b[0]),
            fn(a[1], b[1]),
            fn(a[2], b[2]),
        ];
    }

    res.forEach(buf => {
        if (buf.totalPoints > 0) {
            mins = fx(Math.min, mins, buf.mins);
            maxs = fx(Math.max, maxs, buf.maxs);
            cols = fx(Math.max, cols, buf.colorMaxs);

            totalPoints += buf.totalPoints;
        }
    });


    return {
        buffer: joinFloatBuffers(res.map(r => r.buffer)),
        mins: mins,
        maxs: maxs,
        colorMaxs: cols,
        totalPoints: totalPoints
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
    // this flag will cause all points to rotate by 90 degrees around Y.  This is done so that all points are oriented
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
        let origin = start;
        mat4.translate(trans1, trans1, [-origin[0], -origin[1], -origin[2]]);

        // rotation to rotate around the Y axis
        //
        // figure out the orientation of the segment
        let dir = vec3.subtract(vec3.create(), end, start);
        vec3.normalize(dir, dir);

        // get the angle or rotation required to match up with the X axis
        let rotationAngle = Math.acos(vec3.dot([1, 0, 0], dir));
        if (dir[2] < 0)
            rotationAngle = -rotationAngle;

        // setup the rotation matrix, rotate by rotationAngle around the Y axis
        let matRot = mat4.identity(mat4.create());
        mat4.rotateY(matRot, matRot, rotationAngle);

        // setup translation to move the points offset distance from the origin
        let trans2 = mat4.identity(mat4.create());
        mat4.translate(trans2, trans2, [offset, 0, 0]);


        // combine transforms: trans2 * matRot * trans1
        let matTransform = mat4.multiply(mat4.create(), mat4.multiply(mat4.create(), trans2, matRot), trans1);

        // now transform all points
        let inbuf = buf.buffer;
        let off = 0;
        let sizeInFloats = inbuf.length / buf.totalPoints;

        let v = vec3.create();

        let mins = [Infinity, Infinity, Infinity],
            maxs = [-Infinity, -Infinity, -Infinity];

        for (let i = 0, il = buf.totalPoints ; i < il ; i ++) {
            vec3.set(v, inbuf[off], inbuf[off + 1], inbuf[off + 2]);

            vec3.transformMat4(v, v, matTransform);

            // update mins and maxs
            mins[0] = Math.min(mins[0], v[0]);
            mins[1] = Math.min(mins[1], v[1]);
            mins[2] = Math.min(mins[2], v[2]);

            maxs[0] = Math.max(maxs[0], v[0]);
            maxs[1] = Math.max(maxs[1], v[1]);
            maxs[2] = Math.max(maxs[2], v[2]);

            // store it back
            inbuf[off] = v[0];
            inbuf[off+1] = v[1];
            inbuf[off+2] = v[2];

            off += sizeInFloats;
        }

        buf.mins = mins;
        buf.maxs = maxs;

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

        console.log('start and end', start, end);
        console.log('up, dir, ndir, right', up, dir, ndir, right);

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

        console.log(plane, tolerance, planeHalf, halfLength);


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
                buffer: new Float32Array(0)
            });
        }

        let center = this.pointBBox ?
            this.pointBBox.center() : [0, 0, 0];

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
            let woff = 0, roff = sizeInFloats * startIndex;  // start from

            let mins = [Infinity, Infinity, Infinity],
                maxs = [-Infinity, -Infinity, -Infinity],
                col = [0, 0, 0];

            for (var i = 0 ; i < count ; i ++) {
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

        console.log(buffer, tasks);

        async.map(tasks, ([start, count], cb) => {
            collectPoints(buffer, start, count, cb);
        }, (err, res) => {
            let finalResult = mergeResults(res);

            if (finalResult.totalPoints === 0) {
                console.warn("zero point fetch:", finalResult, res);
            }

            cb(null, finalResult);
        });
    }
}
