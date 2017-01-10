// util.js
// much wow utility functions
//

var vec3 = require("gl-matrix").vec3;
var _ = require("lodash");
var async = require("async");

const Promise = require('bluebird');
const co = Promise.coroutine;

var suc = function(s) {
    return Math.floor(s/100) == 2;
};

var mkqs = function(qs) {
    return _.pairs(qs).map(([k, v]) => {
        return k + "=" + encodeURIComponent(JSON.stringify(v));
    }).join("&");
};

function networkToNative(val) {
    return ((val & 0x00FF) << 24) |
           ((val & 0xFF00) <<  8) |
           ((val >> 8)  & 0xFF00) |
           ((val >> 24) & 0x00FF);
}

var getBinaryInternal = function(url, qs, params) {
    return new Promise((resolve, reject) => {
        var r = new XMLHttpRequest();

        let u = url + "?" + mkqs(qs);

        r.open("GET", u);
        r.withCredentials = (params.creds === true);
        r.responseType = "arraybuffer";

        r.onload = function(e) {
            if (this.readyState === 4) {
                // this request is done
                if (this.status === 200) {
                    let response = this.response;
                    let view = new DataView(response, response.byteLength - 4, 4);
                    let numPoints = networkToNative(view.getUint32(0));

                    // need a better way of doing this
                    response = response.slice(0, response.byteLength - 4);
                    resolve({
                        contentType: this.getResponseHeader('content-type'),
                        response: response,
                        numPoints: numPoints
                    });
                }
                else {
                    reject(new Error('getBinary failed with status:' + this.status));
                }
            }
        };

        r.onerror = function(err) {
            reject(err);
        };

        r.onabort = function() {
            reject(new Error('request aborted.'));
        };

        r.send();
    });
};


var getBinary = getBinaryInternal;

var joinFloatBuffers = function(buffers) {
    let totalSize = buffers.reduce((a, b) => a + b.length, 0);
    let res = new Float32Array(totalSize);

    // copy all buffers in
    var offset = 0;
    buffers.forEach(r => {
        res.set(r, offset);
        offset += r.length;
    });

    return res;
};

var mergeStats = function(stats) {
    let mergeObjects = function(a, b) {
        if (!a && !b) return null;
        if (!a && b) return b;
        if (a && !b) return a;

        let pairs = _.map(b, (val, k) => {
            if (_.isObject(val)) {
                return [k, mergeObjects(val, a[k])];
            }
            else if (_.isArray(val)) {
                return [k, val.concat(a[k])];
            }

            return [k, (a[k] || 0) + val]
        });

        let zipped = _.zipObject(pairs);

        return zipped;
    };

    return stats.reduce(mergeObjects, {});
};

function get(url, params) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function () {
            if (xhr.readyState == 4) {
                if (suc(xhr.status))
                    resolve([xhr.getResponseHeader("content-type"), xhr.responseText]);
                else
                    reject(new Error("unsuccessful code: " + xhr.status));
            }
        };

        xhr.open("GET", url, true);

        xhr.withCredentials = (params.creds === true);
        xhr.send();
    });
};

async function getJson(url, params) {
    const [contentType, data] = await get(url, params);

    if (!contentType.match(/^application\/json/))
        throw new Error("The recieved data type was not JSON, it was: " + contentType);

    return JSON.parse(data.toString('utf-8'));
};

var getWithTimeout = function(url, to, cb) {
    var xmlhttp;
    if (window.XMLHttpRequest) {
        xmlhttp=new XMLHttpRequest();
    }
    else {
        xmlhttp=new ActiveXObject("Microsoft.XMLHTTP");
    }

    xmlhttp.onreadystatechange=function() {
        if (xmlhttp.readyState==4) {
            if (suc(xmlhttp.status))
                cb(null, xmlhttp.responseText);
            else
                cb(new Error("unsuccessful code: " + xmlhttp.status));
        }
    };

    xmlhttp.ontimeout = function() {
        cb(new Error("Timeout"));
    };

    xmlhttp.open("GET",url,true);
    xmlhttp.timeout = to;
    xmlhttp.send();
};


var put = function(url, params, cb) {
    var http = new XMLHttpRequest();
    var p = [];
    for(var k in params) {
        p.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    }

    p = p.join("&");

    http.open("PUT", url, true);

    //Send the proper header information along with the request
    http.setRequestHeader("Content-type", "application/x-www-form-urlencoded");

    http.onreadystatechange = function() {//Call a function when the state changes.
        if(http.readyState == 4) {
            if(suc(http.status)) {
                cb(null, http.responseText);
            }
            else {
                cb(new Error("Unsuccessful error code:", http.status));
            }
        }
    };
    http.send(p);
};

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

var ginside = function(bbox, loc) {
    var x1 = bbox.mins[0];
    var x2 = bbox.maxs[0];

    var y1 = bbox.mins[1];
    var y2 = bbox.maxs[1];
    var x = -loc[0], y = loc[2];

    return (x >= x1 && x < x2 && y >= y1 && y < y2);
};

var getxyScreen = function(evt) {
    // taken from: http://www.javascripter.net/faq/mouseclickeventcoordinates.htm
    //
    var clickX=0, clickY=0;

    if ((evt.clientX || evt.clientY) &&
        document.body &&
        document.body.scrollLeft!=null) {
        clickX = evt.clientX + document.body.scrollLeft;
        clickY = evt.clientY + document.body.scrollTop;
    }
    if ((evt.clientX || evt.clientY) &&
        document.compatMode=='CSS1Compat' &&
        document.documentElement &&
        document.documentElement.scrollLeft!=null) {
        clickX = evt.clientX + document.documentElement.scrollLeft;
        clickY = evt.clientY + document.documentElement.scrollTop;
    }
    if (evt.pageX || evt.pageY) {
        clickX = evt.pageX;
        clickY = evt.pageY;
    }

    return [clickX, clickY];
};

var getxy = function(evt) {
    var x = evt.offsetX==undefined?evt.layerX:evt.offsetX;
    var y = evt.offsetY==undefined?evt.layerY:evt.offsetY;

    return [x, y];
};

/**
 * Converts an HSL color value to RGB. Conversion formula
 * adapted from http://en.wikipedia.org/wiki/HSL_color_space.
 * Assumes h, s, and l are contained in the set [0, 1] and
 * returns r, g, and b in the set [0, 255].
 *
 * Credits: http://stackoverflow.com/questions/2353211/hsl-to-rgb-color-conversion
 *
 * @param   Number  h       The hue
 * @param   Number  s       The saturation
 * @param   Number  l       The lightness
 * @return  Array           The RGB representation
 */

let hue2rgb = function hue2rgb(p, q, t){
    if(t < 0) t += 1;
    if(t > 1) t -= 1;
    if(t < 1/6) return p + (q - p) * 6 * t;
    if(t < 1/2) return q;
    if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
}

function hslToRgb(h, s, l, c){
    let r, g, b;

    if(s == 0){
        r = g = b = l; // achromatic
    }
    else {
        let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        let p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }

    let ret = (c == null) ? [0, 0, 0] : c;

    ret[0] = Math.round(r * 255);
    ret[1] = Math.round(g * 255);
    ret[2] = Math.round(b * 255);

    return ret;
}

var perf_ts = function() {
    if (window.performance)
        return window.performance.now();
    return Date.now();
}
var perf_start = function() {
    return perf_ts();
}

var perf_end = function(start) {
    var t = perf_ts();
    return t - start;
}

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

    if (this.v !== undefined) {
        var o = this;
        this.timer = setTimeout(function() {
            o.timer = null;
            process.nextTick(o.cb.bind(null, o.v));
        }, this.to);
    }
};

TriggeredDispatch.prototype.simulateVal = function() {
	// similar to val, but doesn't take a new value, just reposts the current value,
	// this is needed so that certain UI controls can avoid using forceTrigger
	//
	if (this.v) {
		this.val(this.v);
	}
};

TriggeredDispatch.prototype.forceTrigger = function() {
	// force trigger the last recieved value
	if (this.v) {
        if (this.timer !== null) {
            // there is an active timer, clear it out
            clearTimeout(this.timer);
            this.timer = null;
        }

		process.nextTick(o.cb.bind(null, o.v));
	}
};




class HeightmapCapture {
    constructor(renderer) {
        this.renderer = renderer;
        this.lastCapture = null;
        this.lastCaptureRes = null;
    }


    captureForBounds(res, mins, maxs) {
        var view = mat4.identity(mat4.create());
        mat4.rotateX(view, view, 1.5705);

        // switch the projection X since it grows westwards
        //
        var projLower = [maxs[0], mins[1], mins[2]],
            projUpper = [mins[0], maxs[1], maxs[2]];

        var lower = vec3.transformMat4(vec3.create(), projLower, view);
        var upper = vec3.transformMat4(vec3.create(), projUpper, view);


        // establish our view matrix
        var topDownProjection = mat4.ortho(mat4.create(),
            lower[0], upper[0],
            upper[1], lower[1],
            -1000000, 1000000);

        var proj = mat4.multiply(mat4.create(), topDownProjection, view);

        // ask renderer to do the projection for us
        //
        this.lastCapture = this.renderer.projectToImage(proj, 1, res);
        this.lastCaptureRes = res;
        this.lastCaptureMins = mins;
        this.lastCaptureMaxs = maxs;
    }

    get rawData() {
        return this.lastCapture;
    }

    captureForRadius(res, center, radius) {
        this.captureForBounds(res,
            vec3.subtract(vec3.create(), center, [radius, radius, radius]),
            vec3.add(vec3.create(), center, [radius, radius, radius]));
    }

    worldCoordinatesToPixel(pos) {
        if (!this.lastCapture)
            throw new Error("Nothing has been captured");


        var mins = this.lastCaptureMins,
            maxs = this.lastCaptureMaxs;

        var fx = 1.0 - (pos[0] - mins[0]) / (maxs[0] - mins[0]),
            fy = 1.0 - (pos[2] - mins[2]) / (maxs[2] - mins[2]);

        return [
            Math.floor((this.lastCaptureRes - 1) * fx),
            Math.floor((this.lastCaptureRes - 1) * fy)
        ];
    }


    pixelToWorldCoordinates(x, y) {
        if (!this.lastCapture)
            throw new Error("Nothing has been captured");

        if (x >= this.lastCaptureRes ||
            y >= this.lastCaptureRes)
            throw new Error("Index out of range");

        var mins = this.lastCaptureMins,
            maxs = this.lastCaptureMaxs;

        return [
            mins[0] + x * (maxs[0] - mins[0]) / this.lastCaptureRes,
            this.readPixel(x, y),
            mins[2] + y * (maxs[2] - mins[2]) / this.lastCaptureRes];
    };


    readPixel(x, y) {
        if (!this.lastCapture)
            throw new Error("Nothing has been captured");

        if (x < 0 || x >= this.lastCaptureRes ||
            y < 0 || y >= this.lastCaptureRes)
            throw new Error("Coordinates out of bounds");

        return this.lastCapture [y * this.lastCaptureRes + x];
    }

    toDataURL(s) {
        if (!this.lastCapture)
            throw new Error("Nothing has been captured");

        let m = Number.MIN_SAFE_INTEGER, n = Number.MAX_SAFE_INTEGER;
        let res = this.lastCapture,
            SIZE = this.lastCaptureRes;

        for (var i = 0; i < res.length; i++) {
            m = Math.max(m, res[i]);
            n = Math.min(n, res[i]);
        }

        let c = document.createElement("canvas");
        c.width = c.height = SIZE;

        let ctx = c.getContext("2d");
        var img = ctx.createImageData(SIZE, SIZE);

        let woff = 0;
        for (let off = 0; off < res.length; off++) {
            let v = res[off];
            let col;

            if (Math.abs(v) < 0.000001) {
                // ignore things which are very close to 0, means nothing was renderered there
                col = 0;
            }
            else {
                let clf = (v - n) / (m - n);
                col = Math.floor(clf * 255);
            }

            img.data[woff] = col;
            img.data[woff+1] = col;
            img.data[woff+2] = col;
            img.data[woff+3] = 255;

            woff += 4;
        }

        ctx.putImageData(img, 0, 0);
        return c.toDataURL(s);
    }
}

let randomId = (prefix) => {
    return (prefix || 'id') + '-' + Math.random().toFixed(20).substring(2);
};

let pickPoint = (renderer, [x, y]) => {
    let p = renderer.pickPoint(x, y);

    if (Math.abs(p[0]) < 0.00001 &&
        Math.abs(p[1]) < 0.00001 &&
        Math.abs(p[2]) < 0.00001)
        return null;

    return p;
};

let pickUIPoint = (renderer, [x, y]) => {
    return renderer.pickUIPoint(x, y);
};

let isWindows = function() {
    return navigator.platform.indexOf("Win") === 0;
};

let isLinux = function() {
    return navigator.platform.indexOf("Linux") === 0;
};

let isChrome = function() {
    var isChromium = window.chrome,
        vendorName = window.navigator.vendor;
    return (isChromium !== null && isChromium !== undefined && vendorName === "Google Inc.");
};

let maprange = function(rs, re, v, ts, te) {
    let f = (v - rs) / (re - rs + 0.00001);
    f = Math.max(0, Math.min(1.0, f));
    return (ts + f * (te - ts));
};

/**
 * Compresses a RGB[A] color to a single floating point representation which can then be
 * decoded in GLSL shader programs.
 * @param {Number[]} color A 3 element array of numbers representing RGB color triplet.
 * @returns {number} A single float representing the encoded color.
 */
let compressColor = function(color) {
    let r = color[0],
        g = color[1],
        b = color[2];

    return r / (256 * 256 * 256) + g / (256 * 256) + b / 256 + 0;
};

let parsePlasioParams = function(url) {
    let qIndex = url.indexOf("?");
    if (qIndex === -1) // no query string
        return [url, {}];

    let qs = url.substring(qIndex + 1);
    let parts = qs.split("&");

    let [unknown, known] = parts.reduce(([unknown, known], p) => {
        let [k, v] = p.split("=");

        if (k.indexOf("pl-") === 0) {
            // we recognize this one
            return [unknown,
                    known.concat([k.substring(3), decodeURIComponent(v)])];
        }
        return [unknown.concat([p]),
                known];
    }, [[], []]);

    let paramsMap = {};
    known.forEach(([k, v]) => {
        paramsMap[k] = v
    });

    // reassemble components
    // replace the query string
    return [url.substring(0, qIndex) + "?" + unknown.join("&"),
            paramsMap];
};

let parseURLParams = function(url) {
    let qIndex = url.indexOf("?");
    if (qIndex === -1) // no query string
        return [url, {}];

    let qs = url.substring(qIndex + 1);
    let parts = qs.split("&");

    let params = {};

    parts.forEach((p) => {
        let [k, v] = p.split("=");
        params[k] = decodeURIComponent(v);
    });

    // reassemble components
    // replace the query string
    return [url.substring(0, qIndex),
            params];
};

let interpolateColor = function(out, s, e, f) {
    vec3.lerp(out, s, e, f);
    out[0] = Math.floor(out[0]);
    out[1] = Math.floor(out[1]);
    out[2] = Math.floor(out[2]);

    return out;
};

let parseColor = function(col) {
    if (!col) return null;
    
    let mm = col.match(/^#([0-9a-f]{6})$/i);
    if (!mm) return null;

    let m = mm[1];
    
    return [
        parseInt(m.substr(0,2),16) / 255.0,
        parseInt(m.substr(2,2),16) / 255.0,
        parseInt(m.substr(4,2),16) / 255.0
    ];
}

let joinPath = function(...parts) {
    let withPathCheck = (p) => {
        if (p.match(/^https?:\/\//))
            return p;
        return "http://" + p;
    };

    return parts.slice(1).reduce((p, c) => {
        if (p[p.length-1] === "/")
            return p + c;
        return p + "/" + c;
    }, withPathCheck(parts[0]));
};

var eastingFlipForBounds = function(bounds, fullGeoBounds) {
    var n = fullGeoBounds[0],
        x = fullGeoBounds[3];

    // the X coordinate is special, we go from East -> West as X increases, but in our 3D world
    // we go West to East as X increases, this causes our whole rendering stuff to appear reversed.
    // To keep things simple, we just flip the query here
    //
    // we want to flip the Y coordinate around the X = midX line
    //
    // Formula: px' = 2 * midX - px;
    //
    let midX = n + (x - n) / 2;
    var east = bounds[0],
        west = bounds[3];

    east = 2 * midX - east;
    west = 2 * midX - west;

    // we now need to swap eat and west, since east is now greater than west, we flip them
    var t = east; east = west ; west = t;

    // Don't modify original bounds
    var rbounds = bounds.slice(0);
    rbounds[0] = east;
    rbounds[3] = west;

    return rbounds;
};

var eastingFlipForVector = function(vector, fullGeoBounds) {
    var n = fullGeoBounds[0],
        x = fullGeoBounds[3];

    // the X coordinate is special, we go from East -> West as X increases, but in our 3D world
    // we go West to East as X increases, this causes our whole rendering stuff to appear reversed.
    // To keep things simple, we just flip the query here
    //
    // we want to flip the Y coordinate around the X = midX line
    //
    // Formula: px' = 2 * midX - px;
    //
    let midX = n + (x - n) / 2;
    var dx = vector[0];

    dx = 2 * midX - dx;

    var rvector = vector.slice(0);
    rvector[0] = dx;

    return rvector;
};

let checkParam = function(obj, field, def) {
    if (!obj)
        throw new Error('Source object is not specified');

    const val = obj[field];
    if (val == null) {
        if (def !== undefined) return def;
        throw new Error('Missing required field: ' + field +
            ' among: ' + (Object.keys(obj).join(", ")));
    }

    return val;
};

let boundsCenter = function(arg) {
    if (_.isArray(arg) && arg.length === 6) {
        return [
            arg[0] + (arg[3] - arg[0]) * 0.5,
            arg[1] + (arg[4] - arg[1]) * 0.5,
            arg[2] + (arg[5] - arg[2]) * 0.5
        ];
    }

    throw new Error('Invalid argument, need an array with 6 elements');
};

/**
 * @typedef ParsedSpec
 * A parsed out representation of a brush spec, e.g. <tt>local://elevation</tt>
 * @property {String} scheme The scheme for the spec.  A scheme basically namespaces brushes. e.g. <tt>local</tt>.
 * @property {String} name The name of the spec. e.g. <tt>elevation</tt>.
 * @property {Object.<String, String>} params Parse out parameters similar to a URLs query string.
 */

/**
 * @function
 * Parse a brush's string representation into a usable data structure.
 * @param {String} spec The spec string to parse e.g. <tt>local://color?a=1&b=2</tt>.
 * @return {ParsedSpec} The parse out brush specification.
 */
let parseBrushSpec = function(spec) {
    const parts = spec.split('?');
    if (parts.length > 2)
        throw new Error('Malformed spec, multiple ?, encode your URLs if you\'re specifying them as parameters');

    const firstPart = parts[0];
    const props = parts[1];

    const m = firstPart.match(/^([a-z]+):\/\/(\S+)$/);
    if (!m)
        throw new Error('Malformed spec, should start with a scheme://name, where scheme is all small alphanumeric characters, matched: ' + firstPart);

    const scheme = m[1];
    const name = m[2];
    const params = {};

    if (props) {
        const allParts = props.split('&');
        allParts.forEach(p => {
            const paramParts = p.split('=');
            if (paramParts.length !== 2) {
                throw new Error('Invalid parameter syntax for: ' + p);
            }

            const [key, value] = paramParts;

            // if this paramter already exists, we need to convert it into an array
            if (params[key] && !Array.isArray(params[key])) {
                params[key] = [params[key]];
            }


            // if the value is an array we only push non null values
            if (Array.isArray(params[key])) {
                if (value)
                    params[key].push(value);
            }
            else {
                params[key] = value ? value : null;
            }
        });
    }

    return {
        scheme: scheme,
        name: name,
        params: params
    };
};

/**
 * @function
 * Determines the largest and the smallest number in the supplied array.  Returns a 2-element array with `[min, max]` and elements.
 * If there are no elements in `arrayOfNumbers` then `max > min` is returned.
 *
 * @param {Number[]} arrayOfNumbers An array of number.
 * @return {Number[]} A pair of numbers as `[min, max]`.
 */
let minmax = function(arrayOfNumbers) {
    let n = Number.MAX_SAFE_INTEGER;
    let m = Number.MIN_SAFE_INTEGER;

    for (let i = 0, il = arrayOfNumbers.length ; i < il ; i ++) {
        const number = arrayOfNumbers[i];

        if (n > number) n = number;
        if (m < number) m = number;
    }

    return [n, m]
};

/**
 * Determines if `boundA` is a region enclosing `boundsB`.
 * @function
 * @param {Number[]} boundsA A 6-element array which forms the containing bounds.
 * @param {Number[]} boundsB A 6-element array which forms the contained bounds.
 * @return {Boolean} true if `boundsA` encloses `boundsB`, false otherwise.  If `boundsA` is the same as `boundsB` then `boundsA` is determined
 * to enclose `boundsA` and returns true.
 */
let enclosesBounds = function(boundsA, boundsB) {
    const ab = boundsA;
    const bb = boundsB;

    return ab[0] <= bb[0] && ab[1] <= bb[1] && ab[2] <= bb[2] &&
        ab[3] >= bb[3] && ab[4] >= bb[4] && ab[5] >= bb[5];
};

/**
 * Determines if `boundA` is the same as `boundsB`
 * @function
 * @param {Number[]} boundsA First bounds to compare.
 * @param {Number[]} boundsB Second bounds to compare.
 * @return {Boolean} true if `boundsA` is the same as `boundsB`, false otherwise.
 */
let equalBounds = function(boundsA, boundsB) {
    return (
        boundsA[0] == boundsB[0] &&
        boundsA[1] == boundsB[1] &&
        boundsA[2] == boundsB[2] &&
        boundsA[3] == boundsB[3] &&
        boundsA[4] == boundsB[4] &&
        boundsA[5] == boundsB[5]
    );
};

/**
 * Merge stats into an already existing stats object.
 * @param original {BufferStats} A set of stats histograms to merge the new stats into.
 * @param newStats {BufferStats} A set of stats histograms that need to be merged into `original`.
 * @returns {BufferStats} The updated buffer stats.
 */
let accumulateStats = function(into, newStats) {
    for (let key in newStats) {
        const news = newStats[key];
        const currents = into[key] || {};

        for (let key1 in news) {
            let c = currents[key1] || 0;
            c = c + news[key1];
            currents[key1] = c;
        }

        into[key] = currents;
    }

    return into;
};

module.exports = {
    makeQueryString: mkqs,
    getBinary: getBinary,
    joinFloatBuffers: joinFloatBuffers,
    mergeStats: mergeStats,
    getJson: getJson,
    get: get,
    getWithTimeout: getWithTimeout,
    put: put,
    clamp: clamp,
    geocenter: geocenter,
    geodist: geodist,
    ginside: ginside,
    getxy: getxy,
    getxyScreen: getxyScreen,
    TriggeredDispatch: TriggeredDispatch,
    HeightmapCapture: HeightmapCapture,
    perf_start: perf_start,
    perf_end: perf_end,
    hslToRgb: hslToRgb,
    randomId: randomId,
    pickPoint: pickPoint,
    pickUIPoint: pickUIPoint,
    isWindows: isWindows,
    isLinux: isLinux,
    isChrome: isChrome,
    maprange: maprange,
    compressColor: compressColor,
    parsePlasioParams: parsePlasioParams,
    parseURLParams: parseURLParams,
    interpolateColor: interpolateColor,
    parseColor: parseColor,
    joinPath: joinPath,
    checkParam: checkParam,
    boundsCenter: boundsCenter,
    parseBrushSpec: parseBrushSpec,
    minmax: minmax,
    enclosesBounds: enclosesBounds,
    equalBounds: equalBounds,
    accumulateStats: accumulateStats
};
