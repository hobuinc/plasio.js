/* @flow */

// buffer-loaders.js
// Load stuff from remote buffers
//

var util = require("./util");
var _ = require("lodash");
var LRU = require("lru-cache");
var async = require("async");
var md5 = require("js-md5");
var TileLoader = require("./tile-loaders").TileLoader;

let loadScriptAsBlob = function(script, cb) {
	var xhr = new XMLHttpRequest();
	xhr.open('GET', script, true);
	xhr.responseType = 'blob';
	xhr.withCredentials = false;

	xhr.onload = function(e) {
		if (this.status == 200) {
			// Note: .response instead of .responseText
			var blob = new Blob([this.response], {type: 'text/plain'});
			cb(null, blob);
		}
		else {
			cb(new Error("Failed to download script:" + script));
		}
	};

	xhr.send();
}

var DecompressManager = function(script, count) {
	this.script = script;
	this.free = [];
	this.parked = [];

	var o = this;
	// Try to load the script as a blob since browsers don't execute scripts
	// from remote origins
	var lazPerfLocation = window.LAZPERF_LOCATION || "lib/dist/laz-perf.js";

	async.map([lazPerfLocation, script], loadScriptAsBlob, (err, res) => {
		if (err)
			throw err;

		o.blob = new Blob(res);

		for (var i = 0; i < count; i++) {
			o.free.push(o._newWorker(i));
		}
	});
};

DecompressManager.prototype._newWorker = function(id) {
	let w = null;

	if (this.blob) {
		let U = window.URL || window.webkitURL;
		w = new Worker(U.createObjectURL(this.blob));
	}
	else {
		w = new Worker(this.script);
	}

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

let recolorNode = function(toColor, bounds, propData) {
    // only points that are in range of node's bounding box
    // will need to be colored
    //
    // console.time("recolorNode");
    let targetBufs = toColor.b;

    let readPixel = (p, x, z) => {
        let o = 4 * (p.imageData.width * z + x);
        let d = p.imageData.data;

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
                let imgx = Math.floor(util.maprange(x1, x2, x, imageData.width, 0)),
                    imgz = Math.floor(util.maprange(z1, z2, z, imageData.height, 0));

                for (var ci = 0, cil = _.size(propData) ; ci < cil ; ci ++) {
                    let col = readPixel(propData[ci], imgx, imgz);
                    let coloffset = propData[ci].offset;

                    targetBuf[offset + coloffset] = util.compressColor(col);
                }

                
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

    push(buffer, totalPoints, pointSize, bounds, propagationData, cb) {
        let node = {
            b: [{data: buffer, totalPoints: totalPoints, pointSize: pointSize}],
            bounds: bounds,
            propagationData: propagationData,
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

            console.warn("NEED BURN!", node, childrenNodes);

            // setup burn from all child nodes

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

                if (_.size(node.propagationData) > 0) {
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
        let propagationData = node.propagationData;

        // first collect all parents and then execute coloring on them
        let allParents = [];
        while(parent) {
            allParents.push(parent);
            parent = parent.parent;
        }

        // execute all tasks in parallel if possible, what's important is that we release event loop every
        // so often
        async.each(allParents, (p, cb1) => {
            recolorNode(p, node.bounds, propagationData);
            cb1();
        }, function() {
            cb();
        });
    }
}

let black = [0,0,0];

// A local proxy class to handle dealing with tile loaders and provide an interface
// as we locally expect it to be
class TileLoaderProxy {
    constructor(params) {
        this.url = params.url;
        
        let pp = params.params || {};
        this.loader = new TileLoader(params.url, pp.layout, pp.quality);
        this.params = params;
    }

    queryFor(params) {
        let localParams = this.loader.queryFor(params);
        return {
            type: 'remote',
            params: {
                url: this.url,
                params: localParams
            }
        };
    }

    additionalSchemaItems() {
        // we don't really need anything from the server for tiling
        return [];
    }

    needPropagation() {
        return true;
    }

    prep(p, cb) {
        // fetch imagery here!
        TileLoader.load(this.params, (err, canvas) => {
            if (err) {
                this.data = null;
            }
            else {
                let img = canvas.image;
                let w = img.width,
                    h = img.height;

                let imageData = img.getContext("2d").getImageData(0, 0, w, h).data;

                this.data = {
                    imageData: imageData,
                    w: w, h: h
                };
                this.prepParams = p;
            }
            
            cb();
        });
    }

    color(point) {
        if (!this.data)
            return black;
        
        let x = point.x,
            z = point.z;

        let bbox = this.prepParams.bbox;
        let imageData = this.data.imageData,
            w = this.data.w,
            h = this.data.h;

        let col = Math.floor(util.maprange(bbox[0], bbox[3], x, w, 0)),
            row = Math.floor(util.maprange(bbox[2], bbox[5], z, h, 0));

        let offset = 4 * (row * w + col);
        return [
            imageData[offset],
            imageData[offset + 1],
            imageData[offset + 2]
        ];
    }

    propagationParamsFromLastPrep() {
        return this.data;
    }

    channelClampsPick() {
        return [1, 0, 0, 0];
    }
}

let fieldOrBlack = function(field) {
    let c = [0, 0, 0];
    return function(p) {
        if (p[field]) {
            let colOffset = Math.floor(p[field] * 1000) % 360;
            return util.hslToRgb(colOffset/360, 0.6, 0.6, c);
        }

        return black;
    }
}

let updateStatsRange = (function() {
    let stats = {};
    return function(id, histogram) {
        let currentRange = stats[id] || [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]; // note, they are reversed.
        let vals = _.keys(histogram).map(x => parseInt(x));

        currentRange[0] = Math.min(currentRange[0], _.min(vals));
        currentRange[1] = Math.max(currentRange[1], _.max(vals));

        stats[id] = currentRange;
        return currentRange;
    };
})();


let localComputeFunctions = {
    'origin': fieldOrBlack('origin'),
    'point-source-id': fieldOrBlack('pointsourceid'),
    'color-ramp': (function() {
        let c = [0, 0, 0];
        return function(p) {
            let range = this.zrange;
            let g = Math.max(0, Math.min(1.0, (p.y - range[0]) / (range[1] - range[0] + 0.0001)));

            let startColor = this.start;
            let endColor = this.end;

            c = util.interpolateColor(c, startColor, endColor, g);
            return c;
        };
    })(),
    'elevation': (function() {
        let c = [0, 0, 0];
        return function(p) {
            let range = this.zrange;
            let g = Math.floor(util.maprange(range[0], range[1], p.y, 0, 255));
            c[0] = g; c[1] = g; c[2] = g;
            return c;
        };
    })(),
    'color': (function() {
        let c = [0, 0, 0];
        return function(p) {
            c[0] = (p.red == null) ? 0 : p.red * this.colorScale;
            c[1] = (p.green == null) ? 0 : p.green * this.colorScale;
            c[2] = (p.blue == null) ? 0 : p.blue * this.colorScale;

            return c;
        };
    })(),
    'intensity': (function() {
        let c = [0, 0, 0];
        return function(p) {
            let [l, h] = this.intensityRange;
            let g = (p.intensity == null) ? 0 : Math.floor(util.maprange(l, h, p.intensity, 0, 255));
            c[0] = g; c[1] = g; c[2] = g;
            return c;
        };
    })(),
    'classification': fieldOrBlack('classification')
};

let neededFields = {
    'origin': [["Origin"]],
    'point-source-id': [["PointSourceId"]],
    'color': [["Red", "Green", "Blue"]],
    'intensity': [["Intensity"]],
    'classification': [["Classification"]],
};

class LocalColorLoader {
    constructor(params) {
        this.url = params.url;
        
        let [url, localParams] = util.parseURLParams(params.url);
        
        let match = url.match(/local:\/\/(.*)/);
        if (!match)
            throw new Error("LocalColorLoader initialized without a local:// source");

        this.subtype = match[1];
        this.fn = localComputeFunctions[this.subtype];

        // per subtype validation
        //
        if (this.subtype === "color-ramp") {
            let start = util.parseColor(localParams.start);
            let end = util.parseColor(localParams.end);
            
            if (!start || !end)
                throw new Error("color-ramp start and end colors are required arguments and should be in hex color format with a # in the beginning");

            this.start = start;
            this.end = end;
        }

        if (!this.fn)
            throw new Error('Local color channel not recognized: ' + this.subtype);
    }

    queryFor(params) {
        return {
            type: 'local',
            params: {
                url: this.url
            }
        };
    }

    additionalSchemaItems() {
        // based on the supported subtype we ask for things we want
        //
        let fields = neededFields[this.subtype.toLowerCase()];
        if (fields == null)
            return [];

        return fields;
    }

    needPropagation() {
        return false;
    }

    color(p) {
        return this.fn.call(this, p);
    }

    prep(p, cb) {
        // most don't need any prep
        let is16bit = _.some(_.keys(p.stats.red), v => parseFloat(v) >= 256);

        this.colorScale = is16bit ? (1 / (1 << 8)) : 1;
        this.zrange = updateStatsRange('z', p.stats.z);
        this.intensityRange = updateStatsRange('intensity', p.stats.intensity);

        cb();
    }

    propagationParamsFromLastPrep() {
        return null;
    }

    channelClampsPick() {
        if (this.subtype === "intensity")
            return [0, 0, 1, 0];
        else if (this.subtype === "elevation" || this.subtype === "color-ramp")
            return [0, 1, 0, 0];

        return [1, 0, 0, 0];
    }
}

let makeImagerySource = function(source) {
    if (source.match(/^local:\/\//)) {
        let [url, params] = util.parsePlasioParams(source);

        return new LocalColorLoader({
            url: url,
            params: params
        });
    }
    else if (source.match(/^https?:\/\//)) {
        let [url, params] = util.parsePlasioParams(source);

        return new TileLoaderProxy({
            url: url,
            params: params
        });
    }

    throw new Error("Unrecognized imagery source:" + source);
}

let recoverImagerySourceFromParams = function(params) {
    let sources = {
        'local': LocalColorLoader,
        'remote': TileLoaderProxy
    };

    return _(params)
        .map((v) => {
            if (v == null)
                return null;
            
            let klass = sources[v.type];
            if (!klass)
                throw new Error('Unknown imagery source type: ' + v.type);

            return new klass(v.params);
        })
        .filter(v => v != null)
        .value();
}
                                                      

var GreyhoundPipelineLoader = function(server, resource, schema, params) {
    let imagerySources = params.imagerySources;
    let allowGreyhoundCreds = params.allowGreyhoundCredentials;

    console.log("-- -- imagery source:", imagerySources);

    this.server = server;
    this.resource = resource;
    this.imageLoaders = [];
    this.compressed = true;
    this.sourceSchema = schema;
    this.allowGreyhoundCreds = allowGreyhoundCreds;

    // set all of the loaders
    imagerySources.map((s, i) => {
        this.setColorChannel(i, s);
    });

    if (this.compressed)
        console.log("Compressed buffers have been requested, make sure laz-perf is available, or you'd see errors.");
};


GreyhoundPipelineLoader.key = "greyhound";
GreyhoundPipelineLoader.provides = "point-buffer";

let buildSchema = function(schema, imageLoaders) {
    // basic attributes if supported
    let neededItems = [["X", "Y", "Z"]];

    // if a loader needs additional items get those in as well
    imageLoaders.forEach((s) => {
        if (s != null)
            neededItems = neededItems.concat(s.additionalSchemaItems());
    });

    // make sure that we don't repeat items
    neededItems = _.uniq(neededItems, (i) => i.join());
                         

    let schemaItems = _.zipObject(_.map(schema, (s) => s.name), schema);

    let sout = [];
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

let schemaHasColor = function(schema) {
    let allNames = schema.map(s => s.name.toLowerCase());

    return allNames.indexOf("red") >= 0 &&
        allNames.indexOf("green") >= 0 &&
        allNames.indexOf("blue") >= 0;
}

let decomposePoint = function(buf, off, schema) {
    let r = {};
    schema.forEach((s, i) => {
        r[s.name.toLowerCase()] = buf[off + i];
    });

    return r;
}

let createPointDecomposer = function(schema) {
    let r = {};
    let offsets = [];
    schema.forEach((s, i) => {
        let field = s.name.toLowerCase();
        let offset = i;

        offsets.push([field, offset]);
    });

    let totalItems = schema.length;

    return function(buff, off) {
        for (var i = 0 ; i < totalItems ; i++) {
            r[offsets[i][0]] = buff[off + offsets[i][1]];
        }

        return r;
    }
};

GreyhoundPipelineLoader.prototype.queryFor = function(params) {
    let pointBBox = params.pointCloudBBox;
    let worldBBox = params.worldBBox;
    let fullPointBBox = params.fullPointCloudBBox;

    let schema = buildSchema(this.sourceSchema, this.imageLoaders);

    // for each of the color channels we may have some params
    let imageryParams = {};
    this.imageLoaders.forEach((s, i) => {
        imageryParams['colorSource' + i] = s != null ? s.queryFor(params) : null;
    });

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
        normalize: params.normalize,
        creds: this.allowGreyhoundCreds == true
    };
};

GreyhoundPipelineLoader.prototype.loadHierarchyInfo = function(pointBBox, pointCloudRangeX, depthBegin, depthEnd, cb) {
    let inBounds = pointBBox.mins.concat(pointBBox.maxs);

    let bounds = fixEasting({pointCloudMinX: pointCloudRangeX[0],
                             pointCloudMaxX: pointCloudRangeX[1]},
                            inBounds);

    // swap coordinate space!
    let t = bounds[1]; bounds[1] = bounds[2]; bounds[2] = t;
    t = bounds[4]; bounds[4] = bounds[5]; bounds[5] = t;

    let qs =
        "bounds=" + encodeURIComponent(JSON.stringify(bounds)) + "&" +
        "depthBegin=" + depthBegin + "&" +
        "depthEnd=" + depthEnd;

    let basePath = null;
    if (this.server.match(/^https?:\/\//)) {
        // the user has already supplied us with the prefix
        basePath = this.server;
    }
    else {
        // for a URL for the user
        basePath = "http://" + this.server;
    }

    if (!basePath.endsWith("/")) {
        basePath += "/";
    }

    var u = basePath + "resource/" + this.resource + "/hierarchy?" + qs;
    util.getJson(u, { creds: this.allowGreyhoundCreds }, cb);
}


GreyhoundPipelineLoader.prototype.setColorChannel = function(index, source) {
    if (index >= 4)
        throw new Error('Index needs to be less than 4 when setting color channel');
    
    this.imageLoaders[index] = source == null ? null : makeImagerySource(source);
};

var decompress = new DecompressManager(DECOMPRESS_WORKER_PATH || "workers/decompress.js", 5);

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

var colorizeBufferWithTasks = function(b, schema, total, size, bbox, colorizers, params, cb) {
    if (total === 0)
        return cb(b);

    let inputPointSize = size / 4; // the point as it came from the source
    let totalColorChannels = _.size(colorizers);
    let pointSize = 3 + totalColorChannels; // we only transmit position and color channel information

    // allocate destination array, has all need color channels
    let farray = new Float32Array(total * pointSize);
    let decomposePoint = createPointDecomposer(schema);

    var taskFn = function (start, end) {
        let offr = inputPointSize * start;
        let offw = pointSize * start;

        for (let i = start; i < end; i++) {
            // get the current point as a float array
            let p = decomposePoint(b, offr);

            // position
            farray[offw] = p.x;
            farray[offw + 1] = p.y;
            farray[offw + 2] = p.z;

            // all color channels
            for (let ci = 0 ; ci < totalColorChannels ; ci ++) {
                let is = colorizers[ci];
                let col = is == null ? black : is.color(p);

                farray[offw + 3 + ci] = util.compressColor(col);
            }

            offw += pointSize;
            offr += inputPointSize;
	}
    };

    // when we don't have a ton of points to color, just color them in one go and return the results
    if (total < 10000) {
        taskFn(0, total);
        return cb(farray);
    }

    // we have a significant number of points to color so split task
    let tasksNeeded = Math.ceil(total / 10000); // may be 20K per task
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

var colorizeBuffer = function(schema, b, total, size, bbox, colorizers, params, stats, cb) {
    // prep all colorizers which may include fetching imagery
    async.map(colorizers, (c, cb) => {
        if (c != null) {
            return c.prep({currentParams: params, stats: stats, bbox: bbox}, cb);
        }
        cb();
    }, (err) => {
        if(err) return console.log("PREP ON COLORIZER FAILED:", err)
        // all good, initiate coloring
        colorizeBufferWithTasks(b, schema, total, size, bbox, colorizers, params, cb);
    });
};


var color = (bounds) => {
	let b = JSON.stringify(bounds);
	let s = md5(b);
	return "#" + s.substring(0, 6);
};

var buffercache = new PointBufferCache();

let imageryToAvailableColors = function(imagery) {
    let r = [];
    let count = _.size(_.filter(_.values(imagery), s => s != null));
    for (let i = 0 ; i < 4 ; i ++) {
        r.push((i < count) ? 1 : 0);
    }
    return r;
}


var load = function(params, cb) {
    var server = params.server;
    var resource = params.resource;

    var schema = params.schema;
    var depthBegin = params.depthBegin || 0;
    var depthEnd = params.depthEnd || 8;
    var imagery = params.imagery;

    // compute the incoming point size? Even though we may request the points in unsigned,
    // they are all delviered after conversion into floats
    //
    var incomingPointSize = 4 * schema.length;

    // does the incoming data have color and intensity?
    var hasColor = schemaHasColor(schema)

    let fullPointCloudRangeX = [params.pointCloudMinX, params.pointCloudMaxX];

    // make sure the bound box is fixed for easting correction
    //
    var bbox = fixEasting(params);

    // In our world we always treat Y as going up, but that is not true for point cloud space,
    // in which Z goes up make sure those are flipped
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
        compress: true
    };

    if (params.normalize) qs.normalize = true;

    let basePath = null;
    if (server.match(/^https?:\/\//)) {
        // the user has already supplied us with the prefix
        basePath = server;
    }
    else {
        // for a URL for the user
        basePath = "http://" + server;
    }

    if (!basePath.endsWith("/")) {
        basePath += "/";
    }

    var u = basePath + "resource/" + resource + "/read" ;
    util.getBinary(u, qs, {creds: params.creds}, function(err, buffer) {
        if (err) {
            return cb(err);
	}

        var finishWith = function(buffer, stats) {
            var attrib = [
                ["position", 0, 3]
            ];

            let offset = 3;

            // we support upto four color channels, marked by attributes
            // color0, color1, color2 and color3.

            // if the source already has color, that is one of the inputs, but we may need
            // to create room for other channels, figure out how many channels we need
            let neededColorChannels = _(imagery).values().filter(s => s != null).value().length;
            _.times(neededColorChannels, i => {
                attrib.push(["color" + i, offset, 1]);
                offset += 1;
            });

            let totalIncomingPoints = buffer.byteLength / incomingPointSize;
            // when normalize is turned on, we need to pass the world
            // coordinates and not the point cloud space coordinates since we need
            // to match the coordinate space as it arrives from the server
            //
            let correctedBounds = params.normalize ?
                params.worldMins.concat(params.worldMaxs) :
                params.mins.concat(params.maxs);

            // all the colorizers
            let colorizers = recoverImagerySourceFromParams(imagery);

            let finishBuffer = function(buffer) {
                // our point size if 12 for XYZ and 4 bytes per color channel
                let newPointSize = 12 + neededColorChannels * 4;
                // figure out all of the colorizers which need to propagate their colors
                //
                var propagationData = [];
                var channelClampsPicks = [];
                for (let i = 0 ; i < neededColorChannels ; i ++) {
                    let cc = colorizers[i];

                    let clampPick = cc.channelClampsPick();
                    channelClampsPicks.push(["channelClampsPick" + i, clampPick]);

                    if (cc.needPropagation()) {
                        let pd = cc.propagationParamsFromLastPrep();
                        if (pd) {
                            pd.pointOffset = 3 + i;
                            propagationData.push(pd);
                        }
                    }
                }

                console.log("-- -- RAMPS:", channelClampsPicks);

                buffercache.push(buffer, totalIncomingPoints, newPointSize, correctedBounds,
                                 propagationData,
                                 () => {
                                     console.log("-- -- fin:", totalIncomingPoints);
                                     cb(null, {
                                         pointStride: newPointSize,
                                         totalPoints: totalIncomingPoints,
                                         attributes: attrib,
                                         uniforms: [["availableColors", imageryToAvailableColors(imagery)]].concat(channelClampsPicks),
                                         data: buffer,
                                         stats: stats
                                     });
                                 });
            };

            if (neededColorChannels > 0) {
                // we have some color channels that need to be colored
                colorizeBuffer(schema, buffer, totalIncomingPoints, incomingPointSize, correctedBounds,
                               colorizers, params, stats, finishBuffer);
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
