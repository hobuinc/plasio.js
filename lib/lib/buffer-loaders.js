/* @flow */

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

DecompressManager.prototype.push = function(schema, buffer, pointsCount, worldBoundsX,
											normalize, cb) {
	var o = this;
	var q = {
		schema: schema,
		buffer: buffer,
		pointsCount: pointsCount,
		worldBoundsX: worldBoundsX,
		normalize: normalize
	};

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

let recolorNode = function(toColor, bounds, imageData) {
	// only points that are in range of node's bounding box
	// will need to be colored
	//
	// console.time("recolorNode");
	let targetBufs = toColor.b;

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

	let [x1, y1, z1, x2, y2, z2] = bounds;

	let fx = imgw / (x2 - x1),
		fz = imgh / (z2 - z1);


	for (var i = 0, il = targetBufs.length ; i < il ; i ++) {
		let b = targetBufs[i];

		let wasBufferTouched = false;
		let targetBuf = b.data;
		let totalPoints = b.totalPoints;
		let targetps = b.pointSize / 4;
		let offset = 0;

		for (let j = 0; j < totalPoints; j++) {
			let x = targetBuf[offset + 0],
				y = targetBuf[offset + 1],
				z = targetBuf[offset + 2];

			if (inRange(x, z, bounds)) {
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

	// console.timeEnd("recolorNode");
};

class PointBufferCache {
	constructor() {
		this.roots = []
	}

	push(buffer, totalPoints, pointSize, bounds, sourceImage, propagateColor, cb) {
		let node = {
			b: [{data: buffer, totalPoints: totalPoints, pointSize: pointSize}],
			bounds: bounds,
			image: sourceImage,
			propagateColor: propagateColor,
			children: []
		};

		this.insert(null, this.roots, node, cb);
	}

	print() {
		let p = function(nodes) {
			nodes.forEach(n => {
				p(n.children);
			});
		};

		p(this.roots);
	}

	insert(parent, roots, node, cb) {
		if (_.any(roots, n => isParent(n, node) && isParent(node, n))) {
			return cb(); // don't insert something that is already there
		}

		// for imagery purposes we really don't care about separating Zs, when we get an imagery
		// update for a lower level tree node, we need to make sure that all siblings of the parent are
		// also re-colored.

		// find any nodes here which forms the same quad as this one
		//
		let matching = _.find(roots, n => isSameQuad(n, node));
		if (matching) {
			matching.b.push(node.b[0]);
			// NOTE THAT: We don't need to initate a burn here since we're adding a stacked buffer (varying Y) but still
			// the same X and Z, if this path is followed, then the burn of parents with the current imagery has already
			// happened.
			return cb();
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

			// TODO: Need Burn?
			cb();
		}
		else {
			// off of all the root nodes, find the one we need to go down on
			//
			let nodeToFollow = _.find(roots, (c) => isQuadParent(c, node));

			if (!nodeToFollow) {
				// we couldn't find any path to go down on, which means that this node
				// is now our sibling
				roots.push(node);
				node.parent = parent;

				if (node.propagateColor) {
					this.burnImagery(node, cb);
				}
				else
					cb();
			}
			else {
				// found a path, go down through it
				//
				this.insert(nodeToFollow, nodeToFollow.children, node, cb);
			}
		}
	}

	burnImagery(node, cb) {
		if (!node.parent || !node.image) {
			return cb();
		}

		let parent = node.parent;
		let canvas = node.image.image;
		let imageData = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);

		// first collect all parents and then execute coloring on them
		let allParents = [];
		while(parent) {
			allParents.push(parent);
			parent = parent.parent;
		}

		// execute all tasks in parallel if possible, what's important is that we release event loop every
		// so often
		async.each(allParents, (p, cb1) => {
			recolorNode(p, node.bounds, imageData);
			cb1();
		}, function() {
			cb();
		});
	}
}

let splitBy = function(s, by) {
	let index = s.indexOf(by);
	if (index === -1)
		return [s, ""];

	return [s.substr(0, index), s.substr(index+1)];
};

class LocalColorLoader {
	constructor(subtype) {
		this.subtype = subtype;
	}

	queryFor(bbox) {
		return {source: "local." + this.subtype};
	}

	additionalSchemaItems() {
		return [[this.subtype.substring(0, 1).toUpperCase() +
				this.subtype.substring(1)]];
	}
}

let colorSourceFromImagery = function(imagerySource) {
	let [type, subtype] = splitBy(imagerySource, ".");
	if (type === "mapbox") {
		return new MapboxLoader(subtype);
	}
	else if (type === "local") {
		return new LocalColorLoader(subtype);
	}

	return null;
};

var GreyhoundPipelineLoader = function(server, resource, schema, imagerySource) {
    // each loader needs a key
    this.server = server;
    this.resource = resource;
	this.imageLoader = imagerySource ? colorSourceFromImagery(imagerySource) : null
	this.compressed = true;
	this.sourceSchema = schema;

	if (this.compressed)
		console.log("Compressed buffers have been requested, make sure laz-perf is available, or you'd see errors.");

};


GreyhoundPipelineLoader.key = "greyhound";
GreyhoundPipelineLoader.provides = "point-buffer";

let buildSchema = function(schema, imageLoader) {
	// we definitely want position, color and intensity, and whatever attributes the image loader wants us to
	//
	let sout = [];

	let neededItems = [["X", "Y", "Z"], ["Red", "Green", "Blue"], ["Intensity"]];
	if (imageLoader && imageLoader.additionalSchemaItems)
		neededItems = neededItems.concat(imageLoader.additionalSchemaItems());

	let schemaItems = _.zipObject(_.map(schema, (s) => s.name), schema);

	_.forEach(neededItems, (items) => {
		// only if all needed items are available we ask for them
		if (_.every(items, i => _.has(schemaItems, i))) {
			_.forEach(items, i => sout.push(schemaItems[i]));
		}
	});

	// convert all items to 4 byte ints/floats
	sout = _.map(sout, (s) => {
		if (s.size === 8)
			return _.merge(s, {size: 4});
		return s;
	});

	return sout;
};



GreyhoundPipelineLoader.prototype.queryFor = function(params) {
	let pointBBox = params.pointCloudBBox;
	let worldBBox = params.worldBBox;
	let fullPointBBox = params.fullPointCloudBBox;
	let imageryParams = this.imageLoader ? this.imageLoader.queryFor(params) : null;
	let schema = buildSchema(this.sourceSchema, this.imageLoader);

    return {
        server: this.server,
        resource: this.resource,
        depthBegin: params.depthBegin,
        depthEnd: params.depthEnd,
        mins: pointBBox.mins,
        maxs: pointBBox.maxs,
		worldMins: worldBBox.mins,
		worldMaxs: worldBBox.maxs,
        schema: schema,
		pointCloudMinX: fullPointBBox.mins[0],
		pointCloudMaxX: fullPointBBox.maxs[0],
		imagery: imageryParams,
		normalize: params.normalize
    };
};


GreyhoundPipelineLoader.prototype.setColorSourceImagery = function(source) {
	this.imageLoader = source ? colorSourceFromImagery(source) : null;
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
	var n = params.pointCloudMinX,
		x = params.pointCloudMaxX;

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
	let midX = n + (x - n) / 2;
	var east = bbox[0],
		west = bbox[3];

	east = 2 * midX - east;
	west = 2 * midX - west;

	// we now need to swap eat and west, since east is now greater than west, we flip them
	var t = east; east = west ; west = t;

	bbox[0] = east;
	bbox[3] = west;

	return bbox;
};

var maprange = function(rs, re, v, ts, te) {
	let f = (re - v) / (rs - re);
	return ts + f * (ts - te);
};

var arrayCopy = function(from, to, sourceStart, count) {
	for (let i = 0 ; i < count ; i ++) {
		to[i] = from[sourceStart + i];
	}
};

var colorizeBufferWithTasks = function(b, hasColor, total, size, bbox, colorFn, params, cb) {
	if (total === 0)
		return cb(b);

	let actualSize = size / 4; // the point as it came from the source
	let pointSize = hasColor ? actualSize : actualSize + 3;  // if the source doesn't have color, add it

	let farray = new Float32Array(total * pointSize);

	// TODO: be more robust here, position and color may not be the first 6
	// things in the point, we ask for schema in a certain order, so for now,
	// they most likely are
	//
	// if we have color, extra bytes are 6 less
	//
	let extra = hasColor ? actualSize - 3 : actualSize - 6;
	let pointExtraOffset = hasColor ? 6 : 3; // where do the extra bytes start

	var taskFn = function (start, end) {
		let offr = actualSize * start;
		let offw = pointSize * start;
		let point = new Float32Array(actualSize);

		for (let i = start; i < end; i++) {
			// get the current point as a float array
			arrayCopy(b, point, offr, actualSize);

			// position
			farray[offw] = point[0];
			farray[offw + 1] = point[1];
			farray[offw + 2] = point[2];

			let col = colorFn(point);

			farray[offw + 3] = col[0];
			farray[offw + 4] = col[1];
			farray[offw + 5] = col[2];

			// anything that comes after the position/color is just copied over
			for (let j = 0; j < extra; j++) {
				farray [offw + 6 + j] = point[pointExtraOffset + j];
			}

			offw += pointSize;
			offr += actualSize;
		}
	};

	// when we don't have a ton of points to color, just color them in one go and return the results
	if (total < 15000) {
		taskFn(0, total);
		return cb(farray);
	}

	// we have a significant number of points to color so split task
	let tasksNeeded = Math.ceil(total / 20000); // may be 20K per task
	let pointsPerTask = Math.floor(total / tasksNeeded);
	let tasks = [];
	for (let i = 0 ; i < tasksNeeded ; i ++) {
		// for the last task speciy the total bound since floating point will truncate task size
		tasks.push([i * pointsPerTask,
			(i === tasksNeeded - 1) ? total : ((i + 1) * pointsPerTask)]);
	}

	async.forEach(tasks, ([start, end], cb1) => {
		taskFn(start, end); cb1();
	}, () => cb(farray));
};

let isMapbox = function(source) {
	return source.substr(0, 6) === "mapbox";
}

let localImagerySubtype = function(source) {
	let [a, b] = splitBy(source, ".");

	if (a === "local")
		return b;

	return null;
};

var loadImagery = function(params, cb) {
	if (isMapbox(params.source)) {
		MapboxLoader.load(params, cb);
	}
	else
		throw Error("Trying to load imagery from an unknown imagery source:" + params.source);

};


let updateStatsRange = (function() {
	let statsRange = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]; // note, they are reversed.
	return function(histogram) {
		let vals = _.keys(histogram).map(x => parseInt(x));

		statsRange[0] = Math.min(statsRange[0], _.min(vals));
		statsRange[1] = Math.max(statsRange[1], _.max(vals));

		return statsRange;
	};
})();


let makeColorizerFromParams = function(imagery, schema, bbox, stats) {
	// This function makes a custom colorizer function for the given imagery params,
	// This function is supposed to return a function which takes two arguments, a doneFn
	// which is called when the whole process completes, and then a per point color function
	// which takes a point as a raw buffer with the given schema and then emits a color
	//
	if (isMapbox(imagery.source)) {
		// this is a mapbox source, so we're supposed to return an object which can handle colorization
		//
		return function(colorAllFn, doneFn) {
			loadImagery(imagery, (err, canvas) => {
				let img = canvas.image;
				let w = img.width,
					h = img.height;

				let imageData = img.getContext("2d").getImageData(0, 0, w, h).data;
				var colorFn = function (point) {
					let x = point[0],
						z = point[2];

					let col = Math.floor(maprange(bbox[0], bbox[3], x, 0, w)),
						row = Math.floor(maprange(bbox[2], bbox[5], z, 0, h));

					let offset = 4 * (row * w + col);
					return [
						imageData[offset],
						imageData[offset + 1],
						imageData[offset + 2]
					];
				};

				colorAllFn(colorFn, function(buffer) {
					doneFn(buffer, {image: canvas, propagate: true});
				});
			});
		};
	}
	else {
		var fieldOffsetColorizer = function(name) {
			let offset = _.findIndex(schema, s => (s.name.toLowerCase() === name.toLowerCase()));
			if (offset === -1)
				throw new Error("local." + name + " color source was requested, but the pipeline schema doesn't seem to have " + name + " available");

			let colorFn = function(point) {
				let v = point[offset];
				let colOffset = Math.floor(v * 1000) % 360;
				return util.hslToRgb(colOffset/360, 0.6, 0.6);
			};

			return function(colorAllFn, doneFn) {
				colorAllFn(colorFn, function(buffer) {
					doneFn(buffer, {propagate: false});
				});
			}
		};

		// this is a local source, we need to determine what type it is
		if (localImagerySubtype(imagery.source) === "elevation") {
			if (!stats.z) {
				throw new Error("Z coordinate statistics are needed for local.elevation");
			}

			let range = updateStatsRange(stats.z);
			let colorFn = function(point) {
				let g = maprange(range[0], range[1], point[1], 255, 0);
				return [g, g, g];
			};

			return function(colorAllFn, doneFn) {
				colorAllFn(colorFn, function (buffer) {
					doneFn(buffer, {propagate: false});
				});
			};
		}
		else
		  return fieldOffsetColorizer(localImagerySubtype(imagery.source));
	}

	throw new Error("Requested a colorizer of unknown color source: " + imagery.source);
};

var colorizeBuffer = function(schema, hasColor, b, total, size, bbox, imagery, params, stats, cb) {
	let colorizer = makeColorizerFromParams(imagery, schema, bbox, stats);

	colorizer(function(colorFn, done) {
		colorizeBufferWithTasks(b, hasColor, total, size, bbox, colorFn, params, done);
	}, cb);
};


var color = (bounds) => {
	let b = JSON.stringify(bounds);
	let s = md5(b);
	return "#" + s.substring(0, 6);
};

var buffercache = new PointBufferCache();


var load = function(params, cb) {
	var server = params.server;
	var resource = params.resource;

	var schema = params.schema;
	var depthBegin = params.depthBegin || 0;
	var depthEnd = params.depthEnd || 8;
	var imagery = params.imagery;

	// compute the incoming point size? Even though we may request the points in unsigned, they are all delviered
	// after conversion into floats
	//
	var pointSize = 4 * schema.length;

	// does the incoming data have color and intensity?
	var hasColor = _.some(_.map(schema, s => (s.name === "Red" || s.name === "Green" || s.name === "Blue")));
	var hasIntensity = _.some(_.map(schema, s => (s.name === "Intensity")));

	let fullPointCloudRangeX = [params.pointCloudMinX, params.pointCloudMaxX];

	// make sure the bound box is fixed for easting correction
	//
	var bbox = fixEasting(params);

	// In our world we always treat Y as going up, but that is not true for point cloud space, in which Z goes up
	// make sure those are flipped
	//
	var t;
	t = bbox[1]; bbox[1] = bbox[2]; bbox[2] = t;
	t = bbox[4]; bbox[4] = bbox[5]; bbox[5] = t;

	// prep query
	//
	let qs = {
		schema: schema,
		bounds: bbox,
		depthBegin: depthBegin,
		depthEnd: depthEnd,
		compress: true,
	};

	if (params.normalize)
		qs.normalize = true;


	var u = "http://" + server + "/resource/" + resource + "/read" ;
	util.getBinary(u, qs, function(err, buffer) {
		if (err) {
			return cb(err);
		}

		var finishWith = function(buffer, stats) {
			var attrib = [
				["position", 0, 3]
			];

			var offset = 3;

			// if the source already has color, or we have a non-null imagery override
			// we need to pass down color information, so add that in
			if (hasColor || imagery) {
				attrib.push(["color", offset, 3]);
				offset += 3;
			}

			if (hasIntensity) {
				attrib.push(["intensity", offset, 1]);
				offset += 1;
			}

			let totalPoints = buffer.byteLength / pointSize;
			// when normalize is turned on, we need to pass the world
			// coordinates and not the point cloud space coordinates since we need
			// to match the coordinate space as it arrives from the server
			//
			let correctedBounds = params.normalize ?
				params.worldMins.concat(params.worldMaxs) :
				params.mins.concat(params.maxs);

			let finishBuffer = function(buffer, outparams) {
				let image = outparams.image;
				let needPropagation = outparams.propagate;

				// our point size is size+12 if we latched color on
				let newPointSize = (imagery && !hasColor) ? (pointSize + 12) : pointSize;
				buffercache.push(buffer, totalPoints, newPointSize, correctedBounds,
					image,
					needPropagation,
					() => {
						cb(null, {
							pointStride: newPointSize,
							totalPoints: totalPoints,
							attributes: attrib,
							data: buffer,
							stats: stats
						});
					});
			};

			if (imagery) {
				// there is some imagery paramters setup, so colorize the buffer
				// if we need to color the buffer, we need to query imagery for this block and push it
				//
				colorizeBuffer(schema, hasColor, buffer, totalPoints, pointSize, correctedBounds,
					imagery, params, stats, finishBuffer);
			}
			else {
				// Nothing specified, we don't care, pass the buffer as is.
				finishBuffer(buffer, {});
			}
		};

		if(buffer.numPoints === 0) {
			// The region contains no points, which means that it doesn't affect anything at all,
			// if we let it pass down the finishWith pipeline it will end up coloring it parents, which
			// we don't want for buffers which have no points contribution
			return cb(null, {totalPoints: 0});
		}

		// otherwise do our regular processing, make it go through the decompressor
		// and then finish it up
		//
		decompress.push(
			schema,
			buffer.response,
			buffer.numPoints,
			fullPointCloudRangeX,
			params.normalize,
			function(buf, stats) {
				finishWith(buf, stats);
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

var _cache = new LRU(150);
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



module.exports = {
    GreyhoundPipelineLoader: GreyhoundPipelineLoader,
};
