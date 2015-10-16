// buffer-loaders.js
// Load stuff from remote buffers
//

var util = require("./util");
var _ = require("lodash");
var LRU = require("lru-cache");
var async = require("async");
var md5 = require("js-md5");
var MapboxLoader = require("./tile-loaders").MapboxLoader;

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

			done(e.data.result, e.data.stats);
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

var isParent = function(a, b) {
	let ab = a.bounds;
	let bb = b.bounds;

	return ab[0] <= bb[0] && ab[1] <= bb[1] && ab[2] <= bb[2] &&
			ab[3] >= bb[3] && ab[4] >= bb[4] && ab[5] >= bb[5];
};

var isQuadParent = function(a, b) {
	let ab = a.bounds;
	let bb = b.bounds;

	return ab[0] <= bb[0] && ab[2] <= bb[2] &&
		ab[3] >= bb[3] && ab[5] >= bb[5];
};

var isSameQuad = function(a, b) {
	let ab = a.bounds;
	let bb = b.bounds;

	return ab[0] === bb[0] && ab[2] === bb[2] &&
		ab[3] === bb[3] && ab[5] === bb[5];
};

let snode = function(n) {
	return JSON.stringify(n.bounds);
};

let inRange = function(x, z, [x1, y1, z1, x2, y2, z2]) {
	return x >= x1 && x <= x2 &&
			z >= z1 && z <= z2;
};

let recolorNode = function(toColor, node, imageData) {
	// only points that are in range of node's bounding box
	// will need to be colored
	//
	console.time("recolorNode");
	let offset = 0;
	let targetBufs = toColor.b;
	let wasBufferTouched = false;

	let readPixel = (x, z) => {
		let o = 4 * (imageData.width * z + x);
		let d = imageData.data;

		return [
			d[o],
			d[o + 1],
			d[o + 2]
		];
	};

	let imgw = imageData.width,
		imgh = imageData.height;

	let [x1, y1, z1, x2, y2, z2] = node.bounds;

	let fx = imgw / (x2 - x1),
		fz = imgh / (z2 - z1);


	for (var i = 0, il = targetBufs.length ; i < il ; i ++) {
		let b = targetBufs[i];

		let targetBuf = b.data;
		let totalPoints = b.totalPoints;
		let targetps = b.pointSize / 4;

		for (let j = 0; j < totalPoints; j++) {
			let x = targetBuf[offset + 0],
				y = targetBuf[offset + 1],
				z = targetBuf[offset + 2];

			if (inRange(x, z, node.bounds)) {
				// this point needs to be recolored
				let imgx = Math.floor(maprange(x1, x2, x, 0, imageData.width)),
					imgz = Math.floor(maprange(z1, z2, z, 0, imageData.height));

				let col = readPixel(imgx, imgz);

				targetBuf[offset + 3] = col[0];
				targetBuf[offset + 4] = col[1];
				targetBuf[offset + 5] = col[2];

				wasBufferTouched = true;
			}
			offset += targetps;
		}


		// the renderer would need to be told to reload this buffer again when
		// it renders next (which will be right after we add the node buffer).
		//
		if (wasBufferTouched) {
			targetBuf.update = true;
		}
	}

	console.timeEnd("recolorNode");
};

class PointBufferCache {
	constructor() {
		this.roots = []
	}

	push(buffer, totalPoints, pointSize, sourceImage, bounds) {
		let node = {
			b: [{data: buffer, totalPoints: totalPoints, pointSize: pointSize}],
			bounds: bounds,
			image: sourceImage,
			children: []
		};

		this.insert(null, this.roots, node);
	}

	print() {
		let p = function(nodes) {
			nodes.forEach(n => {
				p(n.children);
			});
		};

		p(this.roots);
	}

	insert(parent, roots, node) {
		if (_.any(roots, n => isParent(n, node) && isParent(node, n))) {
			return; // don't insert something that is already there
		}

		// for imagery purposes we really don't care about separating Zs, when we get an imagery
		// update for a lower level tree node, we need to make sure that all siblings of the parent are
		// also re-colored.

		// find any nodes here which forms the same quad as this one
		//
		let matching = _.find(roots, n => isSameQuad(n, node));
		if (matching) {
			matching.b.push(node.b[0]);


			this.burnImagery(matching);
			return;
		}

		// we can have multiple split roots
		// may be this new buffer becomes the parent of a few or all of them
		let childrenNodes = this.roots.filter(n => isQuadParent(node, n));

		if (childrenNodes.length > 0) {
			// there are some nodes which would like to be chldren of this node
			node.children = childrenNodes;
			node.parent = parent;
			this.roots = _.difference(this.roots, childrenNodes);
			this.roots.push(node);

		}
		else {
			// there are no roots which belong to this new node, we need to start traversing the tree
			// in the other direction now
			//
			let i = 0;
			for (i = 0 ; i < roots.length ; i ++) {
				let r = roots[i];

				if (isQuadParent(r, node)) {
					// go down this path
					this.insert(r, r.children, node);
					break;
				}
			}

			if (i === roots.length) {
				// no candidate found to go down the path
				roots.push(node);
				node.parent = parent;


				// leaf node insertion means we need to initiate burn
				this.burnImagery(node);
			}
		}
	}

	burnImagery(node) {
		// the node itself is correctly burnt up already, we need to walk our way up
		if (!node.parent || !node.image) {
			return;
		}

		let parent = node.parent;
		let canvas = node.image.image;
		let imageData = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);

		console.time("imagery burn");
		while(parent) {
			console.time("--- imagery burn step");
			recolorNode(parent, node, imageData);
			console.timeEnd("--- imagery burn step");
			parent = parent.parent;
		}
		console.timeEnd("imagery burn");
	}
}

var GreyhoundPipelineLoader = function(baseURL, worldBounds, pipelineId, maxDepth, compressed, color, intensity, imageLoader) {
    // each loader needs a key
    this.baseURL = baseURL;
    this.maxDepth = maxDepth || 12;
    this.pipelineId = pipelineId;
	this.worldBounds = worldBounds;
	this.imageLoader = imageLoader;
	this.colorSource = null;

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

GreyhoundPipelineLoader.prototype.queryFor = function(treeBBox, depthBegin, depthEnd) {
	let imageryParams = this.imageLoader.queryFor(treeBBox, this.colorSource);

    return {
        baseURL: this.baseURL,
        pipelineId: this.pipelineId,
        depthBegin: depthBegin,
        depthEnd: depthEnd,
        mins: treeBBox.mins,
        maxs: treeBBox.maxs,
        schema: this.schema,
	    compressed: this.compressed,
	    color: this.color,
	    intensity: this.intensity,
		worldMinX: this.worldBounds[0],
		worldMaxX: this.worldBounds[3],
		imagery: imageryParams
    };
};


GreyhoundPipelineLoader.prototype.setColorSourceImagery = function(source) {
	this.colorSource = source;
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
var isLoadInProgress = function({bbox}) {
	// is a load for this box or one of the boxes which is a contained of it in progress?
	for (var i = 0, il = loadsInProgress.length ; i < il ; i ++) {
		if (bboxSameOrSmaller(loadsInProgress[i].bbox, bbox))
			return loadsInProgress[i];
	}

	return null;
};

var fixEasting = function(params, bbox) {
	var worldMinX = params.worldMinX,
		worldMaxX = params.worldMaxX;

	if (!bbox)
		bbox = params.mins.concat(params.maxs);

	// the X coordinate is special, we go from East -> West as X increases, but in our 3D world
	// we go West to East as X increases, this causes our whole rendering stuff to appear reversed.
	// To keep things simple, we just flip the query here
	//
	// we want to flip the Y coordinate around the X = midX line
	//
	// Formula: px' = 2 * midX - px;
	//
	let midX = worldMinX + (worldMaxX - worldMinX) / 2;
	var east = bbox[0],
		west = bbox[3];

	east = 2 * midX - east;
	west = 2 * midX - west;

	// we now need to swap eat and west, since east is now greater than west, we flipped them
	var t = east; east = west ; west = t;

	bbox[0] = east;
	bbox[3] = west;

	return bbox;
};

var maprange = function(rs, re, v, ts, te) {
	let f = (re - v) / (rs - re);
	return ts + f * (ts - te);
};

var colorizeBuffer = function(b, total, size, bbox, img, params) {
	let pointSize = size / 4;
	let actualSize = (size - 12) / 4 ; // the point size always includes the size of the colors
	let farray = new Float32Array(total * pointSize);

	let offr = 0;
	let offw = 0;

	let extra = actualSize - 3; // take the position out

	let w = img.width,
		h = img.height;
	let imageData = img.getContext("2d").getImageData(0, 0, w, h).data;
	var readPixel = function(x, z) {
		let col = Math.floor(maprange(bbox[0], bbox[3], x, 0, w)),
			row = Math.floor(maprange(bbox[2], bbox[5], z, 0, h));

		let offset = 4 * (row * w + col);
		return [
			imageData[offset],
			imageData[offset + 1],
			imageData[offset + 2]
		];
	};

	console.time("buffer recolor");
	for (let i = 0 ; i < total ; i ++) {
		let x = b[offr + 0],
			y = b[offr + 1],
			z = b[offr + 2];

		// position
		farray[offw + 0] = x;
		farray[offw + 1] = y;
		farray[offw + 2] = z;

		let col = readPixel(x, z);

		farray[offw + 3] = col[0];
		farray[offw + 4] = col[1];
		farray[offw + 5] = col[2];

		for (let j = 0 ; j < extra ; j ++) {
			farray [offw + 6 + j] = b[offr + 3 + j];
		}

		offw += pointSize;
		offr += actualSize;
	}
	console.timeEnd("buffer recolor");

	return farray;
};


var fixedBBox = function(params, bb) {
	let bbox = fixEasting(params, bb);

	// In our world we always treat Y as going up, but that is not true for point cloud space, in which Z goes up
	// make sure those are flipped
	var t;
	t = bbox[1]; bbox[1] = bbox[2]; bbox[2] = t;
	t = bbox[4]; bbox[4] = bbox[5]; bbox[5] = t;

	return bbox;
};

var color = (bounds) => {
	let b = JSON.stringify(bounds);
	let s = md5(b);
	return "#" + s.substring(0, 6);
};

var loadImagery = function(params, cb) {
	/*
	let canvas = document.createElement("canvas");
	canvas.width = 256;
	canvas.height = 256;

	let ctx = canvas.getContext("2d");

	ctx.fillStyle = color(params.bbox);
	ctx.fillRect(0, 0, 256, 256);

	cb(null, {image: canvas, needsFlip: false});
	*/

	MapboxLoader.load(params, cb);
};

var buffercache = new PointBufferCache();


var load = function(params, cb) {
	var baseURL = params.baseURL;
	var pipelineId = params.pipelineId;

	var ADD_COLOR = true;

	var schema = params.schema;
	var depthBegin = params.depthBegin || 0;
	var depthEnd = params.depthEnd || params.maxDepth;
	var pointSize = 12 + ((ADD_COLOR || params.color) ? 12 : 0) + (params.intensity ? 4 : 0);

	var worldMinX = params.worldMinX,
		worldMaxX = params.worldMaxX;

	var bbox = fixEasting(params);

	// In our world we always treat Y as going up, but that is not true for point cloud space, in which Z goes up
	// make sure those are flipped
	var t;
	t = bbox[1]; bbox[1] = bbox[2]; bbox[2] = t;
	t = bbox[4]; bbox[4] = bbox[5]; bbox[5] = t;
	var compressed = params.compressed;

	let qs = {
		schema: schema,
		bounds: bbox,
		depthBegin: depthBegin,
		depthEnd: depthEnd
	};

	if (compressed) {
		qs.compress = true;
	}

	var u = baseURL + "/resource/" + pipelineId + "/read" ;
	util.getBinary(u, qs, function(err, buffers) {
		if (err) {
			return cb(err);
		}

		var finishWith = function(buffer, stats) {
			var attrib = [
				["position", 0, 3]
			];
			var offset = 3;

			if (ADD_COLOR || params.color) {
				attrib.push(["color", offset, 3]);
				offset += 3;
			}


			if (params.intensity) {
				attrib.push(["intensity", offset, 1]);
				offset += 1;
			}

			// when the color's coming from the source, the point size is
			// the real size, otherwise it has the 3 components for color
			let totalPoints =
				params.color ?
					(buffer.byteLength / pointSize) :
					(buffer.byteLength / (pointSize - 12));

			if (ADD_COLOR && !params.color) {
				// if we need to color the buffer, we need to query imagery for this block and push it
				//
				var imagery = params.imagery;
				var proceedWithImage = function(img) {
					let bbox = params.mins.concat(params.maxs);

					buffer = colorizeBuffer(buffer, totalPoints, pointSize, bbox, img.image, params);
					buffercache.push(buffer, totalPoints, pointSize, img, bbox);

					return cb(null, {
						pointStride: pointSize,
						totalPoints: totalPoints,
						attributes: attrib,
						data: buffer,
						stats: stats
					});
				};

				if (imagery) {
					loadImagery(imagery, function(err, image) {
						proceedWithImage(image);
					});
				}
				else
					proceedWithImage(null);
			}
		};

		async.map(buffers, function(item, done) {
			if (compressed) {
				decompress.push(schema, item.response, item.numPoints,
					[worldMinX, worldMaxX], function(buf, stats) {
						done(null, {
							numPoints: item.numPoints,
							stats: stats,
							data: buf
						});
					})
			}
			else {
				done (null, {
					numPoints: item.numPoints,
					stats: {},
					data: item.response
				});
			}
		}, function(err, res) {
			// only a single buffer
			if (res.length === 1) {
				finishWith(res[0].data, res[0].stats);
			}
			else {
				// multiple buffers
				var data = util.joinFloatBuffers(res.map(r => r.data));
				var stats = util.mergeStats(res.map(r => r.stats));

				finishWith(data, stats);
			}
		});
	});
};

var printPending = function() {
	var buf = loadsInProgress.map((load) => load.parked.length.toString());
	let text = buf.join(":");

	if (true) {
		let statusNode = document.getElementById("loader-stats");
		if (!statusNode) {
			statusNode = document.createElement("div");
			statusNode.id = "loader-stats";
			statusNode.style.cssText = "position:fixed;left:0;top:0;color:white;font-family:monospace;padding:5px;";

			document.body.appendChild(statusNode);
		}
		statusNode.innerHTML = text;
	}
};

var _cache = new LRU(500);
GreyhoundPipelineLoader.load = function(params, cb) {
	let key = JSON.stringify(params);
	let data = _cache.get(key);
	if (data) {
		let [err, res] = data;
		return cb(err, res);
	}

	load(params, (err, res) => {
		_cache.set(key, [err, res]);
		cb(err, res);
	});
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
