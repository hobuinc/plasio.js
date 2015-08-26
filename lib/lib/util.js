// util.js
// much wow utility functions
//

var vec3 = require("gl-matrix").vec3;
var async = require("async");

var suc = function(s) {
    return Math.floor(s/100) == 2;
};

var getBinaryInternal = function(url, cb) {
    var r = new XMLHttpRequest();

    r.open("GET", url);
    r.responseType = "arraybuffer";

    r.onload = function(e) {
        if (this.readyState === 4) {
            // this request is done
            if (this.status === 200) {
                cb(null, {
                    contentType: this.getResponseHeader('content-type'),
                    response: this.response,
                    numPoints: parseInt(this.getResponseHeader('X-Greyhound-Num-Points'))
                });
            }
            else
                cb(new Error("Unsuccessful error code: " + this.status));
        }
    };
    r.send();
};


var getBinary = function(baseQuery, depthBegin, depthEnd, cb) {
    var queries = [];
    if (depthBegin === 0) {
        queries.push(baseQuery + "&depthBegin=" +
            encodeURIComponent(JSON.stringify(depthBegin)) +
            "&depthEnd=" +
            encodeURIComponent(JSON.stringify(depthEnd)));
    }
    else {
        let range = depthEnd - depthBegin;

        for (var i = 0; i < range; i++) {
            let s = depthBegin + i,
                e = s + 1;
            queries.push(baseQuery + "&depthBegin=" +
                encodeURIComponent(JSON.stringify(s)) +
                "&depthEnd=" +
                encodeURIComponent(JSON.stringify(e)));
        }
        ;
    }

    async.map(queries, getBinaryInternal, function(err, results) {
        if (err) return cb(err);

        results = results.filter(r => (r.numPoints > 0));
        cb(null, results);

        /*
        if (results.length === 1) {
            cb(null, "", results[0].response, results[0].numPoints);
        }
        else {
            results.forEach(r => console.log(r.response));

            // put all the resulting buffers together
            let totalSize = results.reduce((acc, r) => acc + r.response.byteLength, 0);
            let res = new Uint8Array(totalSize);

            console.log("total size:", totalSize);

            // copy all buffers in
            var offset = 0;
            var totalPoints = 0;
            results.forEach(r => {
                res.set(new Uint8Array(r.buffer), offset);
                offset += r.byteLength;
                totalPoints += r.numPoints;
            });

            cb(null, "", new Float32Array(res.buffer), totalPoints);
        }
         */
    });
};


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

var get = function(url, cb) {
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

    xmlhttp.open("GET",url,true);
    xmlhttp.send();
};

var getJson = function(url, cb) {
    get(url, function(err, contentType, data) {
        if (err) return cb(err);

        if (!contentType.match(/^application\/json/))
            return cb(new Error("The recieved data type was not JSON, it was: " + contentType));

        return cb(null, JSON.parse(data.toString('utf-8')));
    });
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

var getxy = function(evt) {
    var x = evt.offsetX==undefined?evt.layerX:evt.offsetX;
    var y = evt.offsetY==undefined?evt.layerY:evt.offsetY;

    return [x, y];
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


var HeightmapCapture = function(renderer) {
    this.renderer = renderer;
    this.lastCapture = null;
    this.lastCaptureRes = null;
};


HeightmapCapture.prototype.captureForBounds = function(res, mins, maxs) {
    var view = mat4.identity(mat4.create());
    mat4.rotateX(view, view, 1.5705);

    // now determine the two planes
    var wlower = [maxs[0], mins[1], maxs[2]],
        wupper = [mins[0], maxs[1], mins[2]];

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
                                       -10000, 10000);
                                       
    var proj = mat4.multiply(mat4.create(), topDownProjection, view);
    
    // ask renderer to do the projection for us
    //
    this.lastCapture = this.renderer.projectToImage(proj, 2, res);
    this.lastCaptureRes = res;
    this.lastCaptureMins = mins;
    this.lastCaptureMaxs = maxs;
};

HeightmapCapture.prototype.captureForRadius = function(res, center, radius) {
    this.captureForBounds(res,
                          vec3.subtract(vec3.create(), center, [radius, radius, radius]),
                          vec3.add(vec3.create(), center, [radius, radius, radius]));
};

HeightmapCapture.prototype.worldCoordinatesToPixel = function(pos) {
    if (!this.lastCapture)
        throw new Error("Nothing has been captured");
        
       
    var mins = this.lastCaptureMins,
        maxs = this.lastCaptureMaxs;

    var fx = 1.0 - (pos[0] - mins[0]) / (maxs[0] - mins[0]),
        fy = 1.0 - (pos[2] - mins[2]) / (maxs[2] - mins[2]);

    console.log(fx, fy);
    
    return [
        Math.floor((this.lastCaptureRes - 1) * fx),
        Math.floor((this.lastCaptureRes - 1) * fy)
    ];
};


HeightmapCapture.prototype.pixelToWorldCoordinates = function(x, y) {
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


HeightmapCapture.prototype.readPixel = function(x, y) {
    if (!this.lastCapture)
        throw new Error("Nothing has been captured");

    if (x < 0 || x >= this.lastCaptureRes ||
        y < 0 || y >= this.lastCaptureRes)
        throw new Error("Coordinates out of bounds");

    return this.lastCapture [y * this.lastCaptureRes + x];
};

module.exports = {
    getBinary: getBinary,
    joinFloatBuffers: joinFloatBuffers,
    getJson: getJson,
    get: get,
    getWithTimeout: getWithTimeout,
    put: put,
    clamp: clamp,
    geocenter: geocenter,
    geodist: geodist,
    ginside: ginside,
    getxy: getxy,
    TriggeredDispatch: TriggeredDispatch,
    HeightmapCapture: HeightmapCapture,
    perf_start: perf_start,
    perf_end: perf_end
};
