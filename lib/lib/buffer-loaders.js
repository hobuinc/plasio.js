/* @flow */

// buffer-loaders.js
// Load stuff from remote buffers
//

var util = require("./util");
var _ = require("lodash");
var LRU = require("lru-cache");
var vec3 = require("gl-matrix").vec3;

const LoaderWorker = require('worker-loader?inline!./loader-worker');

import { Promise } from 'bluebird';

import { TileLoader } from "./tile-loaders";
import { BaseLoader } from "./base-loader";
import { GeoTransform } from "./geotransform";

import { Device } from "./device";


class BufferLoader {
    constructor(loaderCount) {
        this.loaderCount = loaderCount;

        this.loaders = [];
        for (var i = 0; i < this.loaderCount; i++) {
            this.loaders.push(this._newWorker(i));
        }
    }

    _newWorker(index) {
        const w = new LoaderWorker();

        w.id = index;
        w.processQueue = {};

        w.onmessage = (e) => {
            this._processResponse(w, e.data);
        };

        w.onerror = (e) => {
            console.log("WARNING: Worker crashed!", w);
            this._handleError(w);
        };

        return w;
    }

    _processResponse(worker, data) {
        const requestId = data.id;
        const task = data.task;

        const success = data.success;
        const buffer = data.buffer;
        const numPoints = data.numPoints;
        const stats = data.stats;

        const {resolve, reject} = worker.processQueue[requestId];
        if (!resolve || !reject)
            return console.log('WARNING: Got a response from a webworker for request which has no associated completion promise');

        // Clear out this item from waiting requests and
        delete worker.processQueue[requestId];

        console.log('worker', worker.id, 'queue now has:', Object.keys(worker.processQueue).length, 'items.');

        if (success) {
            resolve({
                buffer: buffer,
                stats: stats,
                numPoints: numPoints
            });
        }
        else {
            reject(new Error('Webworker reported error while trying to process task'));
        }
    }

    _handleError(worker) {
        const id = worker.id;
        this.loaders = this.loaders.filter(w => w.id != id);

        console.log('WARNING: Worker with id', id, 'was decomissioned');
    }

    push(params) {
        util.checkParam(params, 'server');
        util.checkParam(params, 'resource');
        util.checkParam(params, 'bounds');
        util.checkParam(params, 'fullGeoBounds');
        util.checkParam(params, 'scale');
        util.checkParam(params, 'offset');
        util.checkParam(params, 'allowCreds');
        util.checkParam(params, 'schema');
        util.checkParam(params, 'weight');
        util.checkParam(params, 'depthBegin');
        util.checkParam(params, 'depthEnd');

        // find a loader with the minimum amount of load
        const candidate = this.loaders.sort((a, b) =>
            Object.keys(a.processQueue).length - Object.keys(b.processQueue).length)[0];
        const requestId = util.randomId();

        return new Promise((resolve, reject) => {
            candidate.processQueue[requestId] = {
                resolve: resolve,
                reject: reject,
                worker: candidate
            };

            candidate.postMessage({
                id: requestId,
                task: params
            });
        });
    }
}

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

    push(buffer, totalPoints, pointSize, bounds, propagationData) {
        return new Promise((resolve, reject) => {
            let node = {
                b: [{data: buffer, totalPoints: totalPoints, pointSize: pointSize}],
                bounds: bounds,
                propagationData: propagationData,
                children: []
            };

            console.log('xx', 'inserting node:', bounds, propagationData);

            this.insert(null, this.roots, node, resolve);
        });
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

    async prep(p) {
        // fetch imagery here!
        const result = await TileLoader.load(this.params.params);
        const img = result.image;

        const w = img.width,
              h = img.height;
        const imageData = img.getContext("2d").getImageData(0, 0, w, h).data;

        this.data = {
            imageData: imageData,
            w: w, h: h
        };

        this.prepParams = {
            renderSpaceBounds: p.renderSpaceBounds
        };
    }

    colorPoint(point) {
        if (!this.data)
            return black;

        const x = point.x,
              z = point.z;

        const bounds = this.prepParams.renderSpaceBounds;
        const {imageData, w, h} = this.data;

        let col = Math.floor(util.maprange(bounds[0], bounds[3], x, w, 0)),
            row = Math.floor(util.maprange(bounds[2], bounds[5], z, h, 0));

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

    channelColorRamp() {
        return [[0, 0, 0], [1, 1, 1]];
    }

    channelRampContribution() {
        return 0;
    }
}

let fieldOrBlack = function(field, scale) {
    let c = [0, 0, 0];
    const s = scale || 1000;
    return function(p) {
        if (p[field]) {
            let colOffset = Math.floor(p[field] * s) % 360;
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
    'origin-id': fieldOrBlack('originid'),
    'point-id': fieldOrBlack('pointid', 1),
    'point-source-id': fieldOrBlack('pointsourceid'),
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
            c[0] = (p.red == null) ? 0 : Math.floor(p.red * this.colorScale);
            c[1] = (p.green == null) ? 0 : Math.floor(p.green * this.colorScale);
            c[2] = (p.blue == null) ? 0 : Math.floor(p.blue * this.colorScale);

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
    'origin-id': [["OriginId"]],
    'point-id': [["PointId"]],
    'point-source-id': [["PointSourceId"]],
    'color': [["Red", "Green", "Blue"]],
    'intensity': [["Intensity"]],
    'classification': [["Classification"]],
};

/**
 * Point coloring based on local point information.
 */
class LocalColorLoader {
    /**
     * Constructs a clocal color loader
     * @param params The coloring specific params.
     * @param params.url {String} The URL for the color source.
     */
    constructor(params) {
        this.url = params.url;
        
        let [url, localParams] = util.parseURLParams(params.url);
        
        let match = url.match(/^local:\/\/(.*)/);
        if (!match)
            throw new Error("LocalColorLoader initialized without a local:// source");

        this.subtype = match[1];
        this.fn = localComputeFunctions[this.subtype];

        this.start = util.parseColor(localParams.start);
        this.end = util.parseColor(localParams.end);

        if (!this.fn)
            throw new Error('Local color channel not recognized: ' + this.subtype);
    }

    /**
     * Generate required query for state-less loading of this color source
     * @param params Arbitrary tree node information parameters.
     * @return An arbitrary object which will be serialized for buffer querying.
     */
    queryFor(params) {
        return {
            type: 'local',
            params: {
                url: this.url
            }
        };
    }

    /**
     * List addition schema items this color source may required.
     * @return {String[]} A array of schema item names.
     */
    additionalSchemaItems() {
        // based on the supported subtype we ask for things we want
        //
        let fields = neededFields[this.subtype.toLowerCase()];
        if (fields == null)
            return [];

        return fields;
    }

    /**
     * Return true if this color source needs propagation to parent buffers.  This is for imagery sources
     * where a higher resolution image would need to be applied to buffers higher up on the tree.
     * @return {boolean}
     */
    needPropagation() {
        return false;
    }

    /**
     * Given the point information, return the color.
     * @param p The point object, with items available in the respective schema field names, e.g. p.x or p.intensity
     * @return {Number[]} A 3-tuple representing color as RGB.
     */
    colorPoint(p) {
        return this.fn.call(this, p);
    }

    /**
     * Prepare the colorizer for the next batch of incoming points.
     * @param p
     */
    async prep(p) {
        // most don't need any prep
        let is16bit = _.some(_.keys(p.stats.red), v => parseFloat(v) >= 256);

        this.colorScale = is16bit ? (1 / (1 << 8)) : 1;
        this.zrange = updateStatsRange('z', p.stats.z);
        this.intensityRange = updateStatsRange('intensity', p.stats.intensity);
    }

    /**
     *
     * @return {null}
     */
    propagationParamsFromLastPrep() {
        return null;
    }

    channelClampsPick() {
        if (this.subtype === "intensity")
            return [0, 0, 1, 0];
        else if (this.subtype === "elevation")
            return [0, 1, 0, 0];

        return [1, 0, 0, 0];
    }

    /**
     * Get the start and end color for color ramp.
     * @return {*[]} A 2-tuple of 3-tuples representing a pair of RGB triplets.
     */
    channelColorRamp() {
        return [this.start || [0, 0, 0],
                this.end || [1, 1, 1]];
    }

    channelRampContribution() {
        // we want the shaders to recompute the ramps for intensity and elevation
        // but leave the others untouched
        if (this.subtype === "intensity" ||
            this.subtype === "elevation")
            return 1;
        return 0;
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
};

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

            return new klass(v.paams);
        })
        .filter(v => v != null)
        .value();
}

const loader = new BufferLoader(Device.caps().loaderCount);
const buffercache = new PointBufferCache();

/**
 * A buffer loader which loads buffers from greyhound/entwine backend
 * @extends BaseLoader
 */
export class GreyhoundPipelineLoader extends BaseLoader {
    /**
     * A static field describing a namespace for this loader.
     * @return {string}
     */
    static get key() {
        return "greyhound";
    }

    /**
     * A static field describing the kind of data this loader provides.  Values can be 'point-buffer'
     * or 'transform'
     * @return {string}
     */
    static get provides() {
        return "point-buffer";
    }

    /**
     * Construct an instance of a point buffer loader.
     * @param server {string} The server address.
     * @param resource {string} The name of the resource.
     * @param schema {object} Schema definitions
     * @param params.imagerySources {String[]} An array of imagery source specifications.
     * @param [params.allowGreyhoundCredentials] {boolean} Whether to send credentials when making HTTP queries. Defaults to false.
     * @param [params.filter] {object} A JSON object specifying the filter to use. Defaults to no filter.
     */
    constructor(server, resource, schema, params) {
        super();

        const imagerySources = util.checkParam(params, 'imagerySources');
        const allowGreyhoundCreds = util.checkParam(params, 'allowGreyhoundCredentials', false);
        const filter = util.checkParam(params, 'filter', null);

        this.server = server;
        this.resource = resource;
        this.imageLoaders = [];
        this.compressed = true;
        this.sourceSchema = schema;
        this.allowGreyhoundCreds = allowGreyhoundCreds;
        this.filter = filter;

        // set all of the loaders
        imagerySources.map((s, i) => {
            this.setColorChannel(i, s);
        });

        if (this.compressed)
            console.log("Compressed buffers have been requested, make sure laz-perf is available, or you'd see errors.");

        if (!this.compressed)
            throw new Error('Uncompressed buffers are not supported.');
    }

    static _buildSchema(schema, imageLoaders) {
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
    }

    static _schemaHasColor(schema) {
        // if all three color channels exist in schema, we decide it has color
        const allNames = schema.map(s => s.name.toLowerCase());
        return ["red", "green", "blue"].every(c => allNames.indexOf(c) >= 0);
    }

    static _decomposePoint(buf, off, schema) {
        let r = {};
        schema.forEach((s, i) => {
            r[s.name.toLowerCase()] = buf[off + i];
        });

        return r;
    }

    static _createPointDecomposer(schema) {
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
    }

    /**
     * Generate a query for this loader given the specified parameters.
     * @param params
     * @return {object} An object which encodes all needed settings to successfully query a remote resource.  This
     * object should be
     */
    queryFor(params) {
        const renderSpaceBounds = util.checkParam(params, 'renderSpaceBounds');
        const geoTransform = util.checkParam(params, 'geoTransform');

        const depthBegin = util.checkParam(params, 'depthBegin');
        const depthEnd = util.checkParam(params, 'depthEnd');

        let schema = GreyhoundPipelineLoader._buildSchema(this.sourceSchema, this.imageLoaders);

        // for each of the color channels we may have some params
        let imageryParams = {};
        this.imageLoaders.forEach((s, i) => {
            imageryParams['colorSource' + i] = s != null ? s.queryFor(params) : null;
        });

        let result = {
            server: this.server,
            resource: this.resource,
            depthBegin: depthBegin,
            depthEnd: depthEnd,
            renderSpaceBounds: renderSpaceBounds,
            schema: schema,
            imagery: imageryParams,
            fullGeoBounds: geoTransform.fullGeoBounds,
            scale: geoTransform.scale,
            offset: geoTransform.offset,
            creds: this.allowGreyhoundCreds == true
        };

        if (this.filter)
            result.filter = this.filter;

        return result;
    }


    /**
     * Asynchronously load heirarchy information for the given render space bounds.
     * @param renderSpaceBounds {Number[]} A 6-element array specifying the render space bounds for the region to query.
     * @param geoTransform {GeoTransform} The geo transform object for currently loaded resource.
     * @param depthBegin {Number} The start depth for query.
     * @param depthEnd {Number} The end depth for query.
     * @return Returns the hierarchy information.
     */
    async loadHierarchyInfo(renderSpaceBounds, geoTransform, depthBegin, depthEnd) {
        const treeSpaceBounds = geoTransform.transform(renderSpaceBounds, 'render', 'tree');

        let qs =
            "bounds=" + encodeURIComponent(JSON.stringify(treeSpaceBounds)) + "&" +
            "depthBegin=" + depthBegin + "&" +
            "depthEnd=" + depthEnd + "&" +
            "scale=" + encodeURIComponent(JSON.stringify(geoTransform.scale)) + "&" +
            "offset=" + encodeURIComponent(JSON.stringify(geoTransform.offset));

        if (this.filter) {
            qs = qs + "&filter=" + encodeURIComponent(JSON.stringify(this.filter));
        }


        var u = util.joinPath(this.server, "resource", this.resource, "hierarchy") + "?" + qs;
        return await util.getJson(u, { creds: this.allowGreyhoundCreds });
    }

    /**
     * Set the color channel at a specific index. Upto 4 color channels can be set at index 0-3 inclusive.
     * @param index {Number} The index to set the color source as
     * @param source {string} The color source specificiation e.g. local://color.
     */
    setColorChannel(index, source) {
        if (index >= 4)
            throw new Error('Index needs to be less than 4 when setting color channel');

        this.imageLoaders[index] = (source == null) ? null : makeImagerySource(source);
    }

    /**
     * Set the filter specification to the given parameter
     * @param filter {object} Filter specification as a javascript object.`
     */
    setFilter(filter) {
        this.filter = filter;
    }

    static async _colorizeBufferWithTasks(buffer, schema, totalPoints, sizeInBytes, colorizers) {
        if (totalPoints === 0)
            return b;

        let inputPointSizeInFloats = sizeInBytes / 4; // the point as it came from the source, normalized to floats
        let totalColorChannels = _.size(colorizers);
        let outputPointSizeInFloats = 3 + totalColorChannels; // 3 is for X, Y and Z and one float per color channel

        // allocate destination array, has all need color channels
        let coloredBuffer = new Float32Array(totalPoints * outputPointSizeInFloats);
        let decomposePoint = this._createPointDecomposer(schema);

        var taskFn = function (start, end) {
            return new Promise((resolve) => {
                let offr = inputPointSizeInFloats * start;
                let offw = outputPointSizeInFloats * start;

                for (let i = start; i < end; i++) {
                    // get the current point as a float array
                    let p = decomposePoint(buffer, offr);

                    // position
                    coloredBuffer[offw] = p.x;
                    coloredBuffer[offw + 1] = p.y;
                    coloredBuffer[offw + 2] = p.z;

                    // all color channels
                    for (let ci = 0 ; ci < totalColorChannels ; ci ++) {
                        let colorizer = colorizers[ci];
                        let col = colorizer == null ? black : colorizer.colorPoint(p);

                        coloredBuffer[offw + 3 + ci] = util.compressColor(col);
                    }

                    offw += outputPointSizeInFloats;
                    offr += inputPointSizeInFloats;
                }

                resolve();
            });
        };

        // when we don't have a ton of points to color, just color them in one go and return the results
        const BATCH_SIZE = 10000;

        if (totalPoints < BATCH_SIZE) {
            taskFn(0, totalPoints);
            return coloredBuffer;
        }

        let allTasks = [];
        for (let i = 0 ; i < totalPoints ; i += BATCH_SIZE) {
            const start = i;
            const end = Math.min(i + BATCH_SIZE, totalPoints);

            allTasks.push(taskFn(start, end));
        }

        await Promise.all(allTasks);
        return coloredBuffer;
    }

    static async _colorizeBuffer(schema, buffer, totalPoints, sizeInBytes, renderSpaceBounds, colorizers, params, stats) {
        // prep all colorizers which may include fetching imagery
        await Promise.all(colorizers.map(c => c.prep({
            currentParams: params, stats: stats, renderSpaceBounds: renderSpaceBounds
        })));

        // if we have no colorizers, just return the input buffer as it is
        //
        if (colorizers.length === 0)
            return buffer;

        return await this._colorizeBufferWithTasks(buffer, schema, totalPoints, sizeInBytes, colorizers);
    }

    static _imageryToAvailableColors(imagery) {
        let r = [];
        let count = _.size(_.filter(_.values(imagery), s => s != null));
        for (let i = 0 ; i < 4 ; i ++) {
            r.push((i < count) ? 1 : 0);
        }
        return r;
    };


    static async _internalLoad(params, loadParams) {
        const server = util.checkParam(params, 'server');
        const resource = util.checkParam(params, 'resource');

        const schema = util.checkParam(params, 'schema');
        const depthBegin = util.checkParam(params, 'depthBegin');
        const depthEnd = util.checkParam(params, 'depthEnd');
        const imagery = util.checkParam(params, 'imagery');

        const renderSpaceBounds = util.checkParam(params, 'renderSpaceBounds');

        const fullGeoBounds = util.checkParam(params, 'fullGeoBounds');
        const scale = util.checkParam(params, 'scale');
        const offset = util.checkParam(params, 'offset');

        const geoTransform = new GeoTransform(fullGeoBounds, scale, offset);
        const treeSpaceBounds = geoTransform.transform(renderSpaceBounds, 'render', 'tree');

        const [fullPointCloudRangeX] = geoTransform.coordinateSpaceRange('geo');


        const weight = util.checkParam(loadParams, 'weight');

        // compute the incoming point size? Even though we may request the points in unsigned,
        // they are all delivered after conversion into floats
        //
        const incomingPointSize = 4 * schema.length;

        const query =  {
            server: server,
            resource: resource,
            bounds: treeSpaceBounds,
            depthBegin: depthBegin,
            depthEnd: depthEnd,
            fullGeoBounds: fullGeoBounds,
            scale: scale,
            offset: offset,
            allowCreds: params.creds,
            schema: schema,
            weight: weight
        };

        if (params.filter) {
            query.filter = params.filter;
        }

        // decompress data, buffer.response is inaccessible beyond this point
        const decompressedData = await loader.push(query);

        const decompressedBuffer = decompressedData.buffer;
        const totalIncomingPoints = decompressedData.numPoints;
        const decompressedStats = decompressedData.stats;

        if (totalIncomingPoints === 0) {
            return {
                totalPoints: 0
            }
        }

        // build up attributes for this buffer
        let attribs = [["position", 0, 3]];
        let attribOffset = 3;

        // color processing
        let neededColorChannels = _(imagery).values().filter(s => s != null).value().length;

        // Push a color attribute for each needed color channel, only one float per channel
        // because we do some fancy color compression into a single float
        //
        for(let i = 0 ; i < neededColorChannels ; i ++) {
            attribs.push(["color" + i, attribOffset, 1]);
            attribOffset = attribOffset + 1;
        }

        // get all colorizers we need
        let colorizers = recoverImagerySourceFromParams(imagery);

        // do in-place colorization
        const coloredBuffer = await GreyhoundPipelineLoader._colorizeBuffer(
            schema, decompressedBuffer, totalIncomingPoints, incomingPointSize,
            renderSpaceBounds, colorizers, {}, decompressedStats);

        // prep stuff for returning to the renderer
        // our point size if 12 for XYZ and 4 bytes per color channel
        let newPointSize = 12 + neededColorChannels * 4;

        // figure out all of the colorizers which need to propagate their colors
        //
        let propagationData = [];
        let channelClampsPicks = [];
        let channelColorRamps = [];
        let channelRampContribution = [0, 0, 0, 0];
        for (let i = 0 ; i < neededColorChannels ; i ++) {
            let cc = colorizers[i];

            let clampPick = cc.channelClampsPick();
            channelClampsPicks.push(["channelClampsPick" + i, clampPick]);

            let [startColor, endColor] = cc.channelColorRamp();
            channelColorRamps.push(["channelColorRamp" + i + "Start", startColor]);
            channelColorRamps.push(["channelColorRamp" + i + "End", endColor]);

            channelRampContribution[i] = cc.channelRampContribution();

            if (cc.needPropagation()) {
                let pd = cc.propagationParamsFromLastPrep();
                if (pd) {
                    pd.pointOffset = 3 + i;
                    propagationData.push(pd);
                }
            }
        }

        // save this buffer in our cache
        await buffercache.push(coloredBuffer, totalIncomingPoints,
            newPointSize, renderSpaceBounds, propagationData);

        // figure out load result and return it
        const result = {
            pointStride: newPointSize,
            totalPoints: totalIncomingPoints,
            attributes: attribs,
            uniforms: [["availableColors", this._imageryToAvailableColors(imagery)]]
                .concat(channelClampsPicks)
                .concat(channelColorRamps)
                .concat([["channelRampContribution", channelRampContribution]]),
            data: coloredBuffer,
            stats: decompressedStats
        };

        return result;
    }

    /**
     * Load resource for given params which were initially generated through queryFor method.
     * @param params {object} The parameters as generated by the queryFor method, this object should be treated as an
     * opaque object.
     * @param loadParams {object} Additional load time paramters.
     * @param loadParams.weight {Number} Weight of the resource being loaded, higher weight means they are queued first for downloading.
     * @param cb The callback called when the load completes.
     * @return {Promise.<T>} A promise which resolves to the loaded buffer.
     */
    static load(params, loadParams, cb) {
        return GreyhoundPipelineLoader._internalLoad(params, loadParams).then((res) => {
            if(cb) cb(null, res);
            return res;
        }).catch((err) => {
            console.log('buffer load failed with params:', params, loadParams, err);
            if(cb) cb(err);
            else throw err;
        })
    };
}
