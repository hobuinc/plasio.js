// buffer-loaders.js
// Load stuff from remote buffers
//

var util = require("./util");
var _ = require("lodash");

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

DecompressManager.prototype.push = function(schema, buffer, pointsCount, worldBoundsX, cb) {
	var o = this;
	var q = {schema: schema, buffer: buffer, pointsCount: pointsCount, worldBoundsX: worldBoundsX};

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

			// got message back, if we have more stuff waiting, queue it to this
			// worker
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


var GreyhoundPipelineLoader = function(baseURL, worldBounds, pipelineId, maxDepth, compressed, color, intensity) {
    // each loader needs a key
    this.baseURL = baseURL;
    this.maxDepth = maxDepth || 12;
    this.pipelineId = pipelineId;
	this.worldBounds = worldBounds;

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
    return !!zeroReturns[key];
};


var _isPossiblyAZeroReturn = function(bbox) {
	// Conditions for a zero return
	// 1. This bounding box is in list of zero returns
	// 2. This bbox is completely contained inside a zero return (longer)
	//
	if (GreyhoundPipelineLoader.zeroReturn(bbox[0], bbox[1], bbox[2], bbox[3], bbox[4], bbox[5])) {
		return true;
	}

	var isInside = function(box) {
		var xs = box[0], ys = box[1], zs = box[2],
			xe = box[3], ye = box[4], ze = box[5];

		return (bbox[0] >= xs && bbox[1] >= ys && bbox[2] >= zs &&
			bbox[3] <= xe && bbox[4] <= ye && bbox[5] <= ze);
	};

	for (var k in zeroReturns) {
		var thisBBox = zeroReturns[k];

		if (isInside(thisBBox))
			return true;
	}

	return false;
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
	    intensity: this.intensity,
		worldMinX: this.worldBounds[0],
		worldMaxX: this.worldBounds[3]
    };
};


var decompress = new DecompressManager(DECOMPRESS_WORKER_PATH || "/workers/decompress.js", 5);

var generateBuffer = function(depthStart, depthEnd, bbox) {
	var x1 = bbox[0], x2 = bbox[3],
	    y1 = bbox[1], y2 = bbox[4],
	    z = bbox[2] + (bbox[5] - bbox[2]) / 2;

	var w = 16, h = 16;
	var pointCount = w * h;

	var buffer = new Float32Array(pointCount * 6);

	var off = 0;
	for (var i = 0 ; i < w ; i ++) {
		var x = x1 + (x2 - x1) * (i / w);

		for (var j = 0 ; j < h ; j ++) {
			var y = y1 + (y2 - y1) * (j / h);

			buffer[off + 0] = x;
			buffer[off + 1] = z;
			buffer[off + 2] = y;

			buffer[off + 3] = 255.0;
			buffer[off + 4] = 255.0;
			buffer[off + 5] = 255.0;

			off += 6;
		}
	}

	return buffer;
};

var bboxSameOrSmaller = function(a, b) {
	var [xs, ys, zs, xe, ye, ze] = a;
	var [bxs, bys, bzs, bxe, bye, bze] = b;

	return (
		bxs >= xs &&
		bys >= ys &&
		bzs >= zs &&
		bxe <= xe &&
		bye <= ye &&
		bze <= ze);
}

var loadsInProgress = [];
var isLoadInProgress = function(bbox) {
	// is a load for this box or one of the boxes which is a contained of it in progress?
	for (var i = 0, il = loadsInProgress.length ; i < il ; i ++) {
		if (bboxSameOrSmaller(loadsInProgress[i].bbox, bbox))
			return loadsInProgress[i];
	}

	return null;
};

var fixEasting = function(params) {
	var worldMinX = params.worldMinX,
		worldMaxX = params.worldMaxX;

	// the X coordinate is special, we go from East -> West as X increases, but in our 3D world
	// we go West to East as X increases, this causes our whole rendering stuff to appear reversed.
	// To keep things simple, we just flip the query here
	//
	// we want to flip the Y coordinate around the X = midX line
	//
	// Formula: px' = 2 * midX - px;
	//
	let midX = worldMinX + (worldMaxX - worldMinX) / 2;
	var east = params.mins[0],
		west = params.maxs[0];

	east = 2 * midX - east;
	west = 2 * midX - west;

	// we now need to swap eat and west, since east is now greater than west, we flipped them
	var t = east; east = west ; west = t;

	var bbox = [east, params.mins[1], params.mins[2], west, params.maxs[1], params.maxs[2]];

	return bbox;
};


var load = function(params, cb) {
	var baseURL = params.baseURL;
	var pipelineId = params.pipelineId;

	var schema = params.schema;
	var depthBegin = params.depthBegin || 0;
	var depthEnd = params.depthEnd || params.maxDepth;
	var maxDepth = params.maxDepth;
	var pointSize = 12 + (params.color ? 12 : 0) + (params.intensity ? 4 : 0);

	var worldMinX = params.worldMinX,
		worldMaxX = params.worldMaxX;

	var bbox = fixEasting(params);


	if (_isPossiblyAZeroReturn(bbox)) {
		// if its potentially a zero return query, we need to make sure we just return
		console.log("++++++++++++ POTENTIAL ZERO:", bbox);
		return setTimeout(() => {
			cb(null, {
				pointStride: 0,
				totalPoints: 0,
				attributes: [],
				data: null
			});
		});
	}

	// In our world we always treat Y as going up, but that is not true for point cloud space, in which Z goes up
	// make sure those are flipped
	var t;
	t = bbox[1]; bbox[1] = bbox[2]; bbox[2] = t;
	t = bbox[4]; bbox[4] = bbox[5]; bbox[5] = t;
	var compressed = params.compressed;

	var qs = "depthBegin=" + encodeURIComponent(JSON.stringify(depthBegin)) + "&" +
		"depthEnd=" + encodeURIComponent(JSON.stringify(depthEnd)) + "&" +
		"schema=" + encodeURIComponent(JSON.stringify(schema)) + "&" +
		"bbox=" + encodeURIComponent(JSON.stringify(bbox));


	if (compressed) {
		qs += "&compress=true";
	}

	if (false) {
		setTimeout(function() {
			var b = generateBuffer(depthBegin, depthEnd, bbox);

			cb(null, {
				pointStride: 24,
				totalPoints: b.length / 6,
				attributes: [
					["position", 0, 3], // attribute name and offset and total number of floating point values
					["color", 3, 3]
				],
				data: b
			});
		});
	}
	else {
		var u = baseURL + "/resource/" + pipelineId + "/read?" + qs;

		util.getBinary(u, function(err, contentType, data, pointsCount) {
			console.log("depthBegin:", depthBegin, ", depthEnd:", depthEnd,
				", area:", (bbox[3] - bbox[0]) * (bbox[4] - bbox[1]),
				", volume:", (bbox[3] - bbox[0]) * (bbox[4] - bbox[1]) * (bbox[5] - bbox[2]),
				(err ? "FAILED" : "SUCCESS " + pointsCount + " points"));

			if (err) {
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
					var key = zeroReturnsKey(
						params.mins[0], params.mins[1], params.mins[2],
						params.maxs[0], params.maxs[1], params.maxs[2]);

					zeroReturns[key] = [
						params.mins[0], params.mins[1], params.mins[2],
						params.maxs[0], params.maxs[1], params.maxs[2]
					];
				}

				return cb(null, {
					pointStride: pointSize,
					totalPoints: buffer.byteLength / pointSize,
					attributes: attrib,
					data: buffer
				});
			};

			if (compressed) {
				return decompress.push(schema, data, pointsCount, [worldMinX, worldMaxX], finishWith);
			}

			return finishWith(new Float32Array(data));
		});
	}
};

GreyhoundPipelineLoader.loadInternal = function(params, cb) {
	// slightly smarter loading, if we already have a bbox which is entirely contained
	// inside one of the volumes being loaded, wait for it to finish to make sure we don't have zero returns
	//
	var bbox = fixEasting(params);
	var parentLoad = isLoadInProgress(bbox);

	console.log(bbox, parentLoad);

	if (parentLoad) {
		console.log("parked!");
		return parentLoad.parked.push([params, cb]);
	}

	// there is no parent load in progress for this bound, so try our standard load for it
	var download = {
		bbox: bbox,
		parked: []
	};

	loadsInProgress.push(download);

	load(params, function(err, res) {
		// this download is done, remove it from in progress downloads
		_.remove(loadsInProgress, n => n === download);
		if (err) {
			// fail this call and all parked ones under it
			cb(err);
			download.parked.forEach(([p, f]) => f(err));
			return;
		}

		// if this is zero return, then all children as zero return
		//
		let pointCount = res.totalPoints;
		if (pointCount === 0) {
			console.log("ZERO", download.parked.length);
			cb(null, res);
			download.parked.forEach(([p, f]) => f(null, res));
			return;
		}

		// notify that we loaded, but we have dependent loads
		cb(null, res, download.parked);
	});
};

var bboxvol = function(bbox) {
	var [a, b, c, d, e, f] = bbox;
	return (d - a) * (e - b) * (f - c);
};

class LoadQueue {
	constructor() {
		this.pending = [];
		this.max = 5;
		this.running = false;
	}

	push(params, cb) {
		var bbox = params.mins.concat(params.maxs);
		var weight = bboxvol(bbox);

		var obj = {
			weight: weight, params: params, cb: cb
		};

		// find the most appropriate place for this spot
		//
		var index = _.findIndex(this.pending, n => n.weight < weight);
		if (index === -1)
			this.pending.push(obj);
		else
			this.pending.splice(index, 0, obj);

		if (!this.running)
			this._startDownloader();
	}

	_startDownloader() {
		var o = this;

		if (o.running)
			return;

		var step = function() {
			// whatever is pending, queue it all up, they should form a hierarchy based on the dependence of one
			// buffer on another
			//
			if (o.pending.length > 0)
				o.running = true;

			while (o.pending.length > 0) {
				var task = o.pending.shift();
				let {weight, params, cb} = task;

				// if we already know that this buffer is zero return then we don't need to do any scheduling for it
				//
				var bbox = params.mins.concat(params.maxs);
				if (_isPossiblyAZeroReturn(bbox)) {
					console.log("------ quick zero return");
					cb(null, {
						totalPoints: 0
					});
				}
				else {
					// this buffer may need to be downloaded, so queue it
					GreyhoundPipelineLoader.loadInternal(params, function(err, res, requeue) {
						cb(null, res);

						o.running = false;

						if (requeue && requeue.length > 0) {
							requeue.forEach(([params, cb]) => o.push(params, cb));
							setTimeout(step, 0);
						}
					});
				}
			}
		};

		o.running = true;
		setTimeout(step, 0);
	}
}

var _loadQueue = new LoadQueue();
GreyhoundPipelineLoader.load = function(params, cb) {
	_loadQueue.push(params, cb);
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
