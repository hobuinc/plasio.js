// buffer-loaders.js
// Load stuff from remote buffers
//

var util = require("./util");

var DecompressManager = function(script, count) {
	this.script = script;
	this.free = [];
	this.parked = [];
	for (var i = 0 ; i < count ; i ++) {
		this.free.push(this._newWorker(i));
	}
};

DecompressManager.prototype._newWorker = function(id) {
	var w = new Worker(this.script);
	w.id = id;
	w.count = 0;

	return w;
};

DecompressManager.prototype.push = function(schema, buffer, pointsCount, cb) {
	var o = this;
	var q = {schema: schema, buffer: buffer, pointsCount: pointsCount};

	var dispatch = function(worker, query, done) {
		worker.postMessage(query);

		worker.onerror = function(e) {
			// make a new worker and push it back in
			worker.terminate();

			var w = o._newWorker(worker.id);
			o.free.push(w);
		};
		
		worker.onmessage = function(e) {
			worker.count ++;
			/*
			if (worker.count > 3) {
				worker.terminate();

				console.log("WORKER RECYCLE: ", worker.id);
				worker = o._newWorker(worker.id);
			}
			 */
			// got message back, if we have more stuff waiting, queue it to this
			// worke
			var next = o.parked.shift();
			if (next) {
				setTimeout(dispatch.bind(null, worker, next[0], next[1]));
			}
			else {
				o.free.push(worker);
			}

			done(e.data.result);
		};
	};

	var worker = o.free.shift();  // SHIFTs are considered O(n), mmkay? but for short arrays like this its no problem

	if (!worker) {
		// uh oh, no workers, park this
		this.parked.push([q, cb]);
	}
	else {
		dispatch(worker, q, cb);
	}
};


var GreyhoundPipelineLoader = function(baseURL, pipelineId, maxDepth, compressed, color, intensity) {
    // each loader needs a key
    this.baseURL = baseURL;
    this.maxDepth = maxDepth || 12;
    this.pipelineId = pipelineId;

	this.compressed = (typeof compressed === 'undefined') ? false : compressed;

	if (this.compressed)
		console.log("Compressed buffers have been requested, make sure laz-perf is available, or you'd see errors.");

    // TODO: no schema overrides for now
    //
    this.schema = [{name: "X", type: "floating", size: 4},
                   {name: "Y", type: "floating", size: 4},
                   {name: "Z", type: "floating", size: 4}];

	if (color) {
		this.color = true;
		this.schema = this.schema.concat(
			[{name: "Red", type: "floating", size: 4},
			 {name: "Green", type: "floating", size: 4},
			 {name: "Blue", type: "floating", size: 4}]);
	}

	if (intensity) {
		this.intensity = true;
		this.schema = this.schema.concat(
			[{name: "Intensity", type: "floating", size: 4}]);
	}
};

    
GreyhoundPipelineLoader.key = "greyhound";
GreyhoundPipelineLoader.provides = "point-buffer";

var zeroReturnsKey = function(xs, ys, zs, xe, ye, ze) {
    return xs.toFixed(2) + ":" +
        xs.toFixed(2) + ":" +
        zs.toFixed(2) + ":" +
        xe.toFixed(2) + ":" +
        ye.toFixed(2) + ":" +
        ze.toFixed(2);
};

var zeroReturns = {}; // bounds for which zero points were returned and 

GreyhoundPipelineLoader.zeroReturn = function(xs, ys, zs, xe, ye, ze) {
    var key = zeroReturnsKey(xs, ys, zs, xe, ye, ze);
    return zeroReturns[key] === true;
};

GreyhoundPipelineLoader.prototype.queryFor = function(treeBBox, depthBegin, depthEnd) {
    return {
        baseURL: this.baseURL,
        pipelineId: this.pipelineId,
        depthBegin: depthBegin,
        depthEnd: depthEnd,
        mins: treeBBox.mins,
        maxs: treeBBox.maxs,
        maxDepth: this.maxDepth,
        schema: this.schema,
	    compressed: this.compressed,
	    color: this.color,
	    intensity: this.intensity
    };
};


var decompress = new DecompressManager(DECOMPRESS_WORKER_PATH || "/workers/decompress.js", 5);

var generateBuffer = function(depthStart, depthEnd, bbox) {
	var x1 = bbox[0], x2 = bbox[2],
	    y1 = bbox[1], y2 = bbox[3];

	var pointCount = 65536;
	var w = 256, h = 256;

	var buffer = new Float32Array(pointCount * 3);

	var off = 0;
	for (var i = 0 ; i < w ; i ++) {
		var x = x1 + (x2 - x1) * (i / w);

		for (var j = 0 ; j < h ; j ++) {
			var y = y1 + (y2 - y1) * (j / h);

			buffer[off + 0] = x;
			buffer[off + 1] = y;
			buffer[off + 2] = 0.0;

			off += 3;
		}
	}

	return buffer;
};

GreyhoundPipelineLoader.load = function(params, cb) {
    var baseURL = params.baseURL;
    var pipelineId = params.pipelineId;

    var schema = params.schema;
    var depthBegin = params.depthBegin || 0;
    var depthEnd = params.depthEnd || params.maxDepth;
	var maxDepth = params.maxDepth;
	var pointSize = 12 + (params.color ? 12 : 0) + (params.intensity ? 4 : 0);

    var bbox = [params.mins[0], params.mins[1], params.mins[2], params.maxs[0], params.maxs[1], params.maxs[2]];

	var compressed = params.compressed;
    
    var qs = "depthBegin=" + encodeURIComponent(JSON.stringify(depthBegin)) + "&" +
            "depthEnd=" + encodeURIComponent(JSON.stringify(depthEnd)) + "&" +
            "schema=" + encodeURIComponent(JSON.stringify(schema)) + "&" +
            "bbox=" + encodeURIComponent(JSON.stringify(bbox));


	if (compressed) {
		qs += "&compress=true";
	}

	if (true) {
        setTimeout(function() {
	        var b = generateBuffer(depthBegin, depthEnd, bbox);

            cb(null, {
                pointStride: 12,
                totalPoints: b.length / 3,
                attributes: [
                    ["position", 0, 3] // attribute name and offset and total number of floating point values
                ],
                data: b
            });
        });
	}
	else {
		var u = baseURL + "/resource/" + pipelineId + "/read?" + qs;

		util.getBinary(u, function(err, contentType, data, pointsCount) {
			if (err) {
				console.log("FAILED! depthBegin:", depthBegin, ", depthEnd:", depthEnd,
					", area:", (bbox[3] - bbox[0]) * (bbox[4] - bbox[1]),
					", volume:", (bbox[3] - bbox[0]) * (bbox[4] - bbox[1]) * (bbox[5] - bbox[2]));
				return cb(err);
			}

			var finishWith = function(buffer) {
				var attrib = [
					["position", 0, 3]
				];
				var offset = 3;

				if (params.color) {
					attrib.push(["color", offset, 3]);
					offset += 3;
				}

				if (params.intensity) {
					attrib.push(["intensity", offset, 1]);
					offset += 1;
				}

                // take a note of zero returns
                if (buffer.byteLength === 0) {
                    var key = zeroReturnsKey(bbox[0], bbox[1], bbox[2],
                                             bbox[3], bbox[4], bbox[5]);
                    zeroReturns[key] = true;
                }

				return cb(null, {
					pointStride: pointSize,
					totalPoints: buffer.byteLength / pointSize,
					attributes: attrib,
					data: buffer
				});
			};

			if (compressed) {
				return decompress.push(schema, data, pointsCount, finishWith);
			}

			return finishWith(new Float32Array(data));
		});
	}
};


var GreyhoundStaticLoader = function(baseURL) {
    this.baseURL = baseURL;
};

GreyhoundStaticLoader.prototype.queryFor = function(treeBBox, depthBegin, depthEnd) {
    var s = JSON.stringify({
        mins: treeBBox.mins, maxs: treeBBox.maxs,
        depthBegin: depthBegin,
        depthEnd: depthEnd
    });

    var sha = createHash('sha1');
    sha.update(s);
    var h = sha.digest('hex');

    return h;
};

GreyhoundStaticLoader.load = function(params, cb) {
    var url = specs.baseURL + "/" + id;

    util.getBinary(url, true, function(err, contentType, data) {
        if (err) return cb(err);

        var a = new Float32Array(data);
        var pointCount = a.length / 8;


        if (params.debugColor) {
            var c = [parseInt(id.substring(0, 2), 16),
                     parseInt(id.substring(2, 4), 16),
                     parseInt(id.substring(4, 6), 16)];

            for (var i = 0 ; i < pointCount ; i++) {
                a[8*i + 3] = c[0];
                a[8*i + 4] = c[1];
                a[8*i + 5] = c[2];
            }
        }

        return cb(null, a); 
    });
};




module.exports = {
    GreyhoundPipelineLoader: GreyhoundPipelineLoader,
    GreyhoundStaticLoader: GreyhoundStaticLoader
};
