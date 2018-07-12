// Loader worker
// Loads and processes data buffers from greyhound

import 'babel-polyfill'

import { Promise } from "bluebird";
import { GeoTransform } from "./geotransform";
import { getBinary, joinPath, pickOne } from "./util";

// how do new style names map to the size/getter functions
//
const typeMappings = {
    'float': [4, DataView.prototype.getFloat32],
    'double': [8, DataView.prototype.getFloat64],

    'int8': [1, DataView.prototype.getInt8],
    'int16': [2, DataView.prototype.getInt16],
    'int32': [4, DataView.prototype.getInt32],

    'uint8': [1, DataView.prototype.getUint8],
    'uint16': [2, DataView.prototype.getUint16],
    'uint32': [4, DataView.prototype.getUint32]
};

/**
 * A class to manage buffer download, takes care of queueing and buffer post processing
 */
class BufferDownloadPipeline {
    /**
     * Constructs a buffer download pipeline.
     * @param [activeDownloads] How many active downloads to have running at any time. Defaults to 5.
     */
   constructor(activeDownloads) {
       this.activeDownloads = activeDownloads || 5;
       this.pending = [];

       this.activeCount = 0;
       this.ready = false;
   }

    /**
     * Queue a download and process task. The task is placed in queue based on the task's weight.
     * @param task A task object which specifies what to download.
     */
   queue(task) {
       // find where this goes in our load list, find the first spot where the weight
       // of item in our list is lower than us.
       const index = this.pending.findIndex(t => task.weight > t.weight);
       if (index == -1) {
           this.pending.push(task);
       }
       else {
           this.pending.splice(index, 0, task);
       }

       // try to start the downloader, this may not do anything if stuff is already downloading
       this._doNext();
   }

    /**
     * Mark the queue as ready, indicating that decompression runtime is ready.
     */
   markReady() {
       this.ready = true;
       this._doNext();
   }

   _notifyParent(task, status, result) {
       const payload = {
           id: task.id,
           success: status,
           buffer: result.buffer,
           numPoints: result.numPoints || 0,
           stats: result.stats
       };

       if (result.numPoints === 0)
           console.warn('zero point task:' + task.bounds);

       postMessage(payload);
   }

    _doNext() {
       if (this.activeCount >= this.activeDownloads || !this.ready)
           return; // No more tasks can be run, so wait for things to complete

        const task = this.pending.shift();
        if (!task) {
            console.log('download queue has been exhausted.');
            return; // no more tasks
        }

        this.activeCount ++;
        processTask(task)
            .then((result) => {
                // we now have buffer in result
                this._notifyParent(task, true, result);
            })
            .catch((e) => {
                console.log(e);
                this._notifyParent(task, false, {});
            })
            .finally(() => {
                this.activeCount --;
                setTimeout(() => this._doNext(), 0);
            });
    }
}

function swapSpace(buffer, worldBoundsX, pointSize, numPoints, normalize) {
    // we assume we have x, y and z as the first three floats per point
    // we are useless without points anyway
    var step = pointSize / 4; // every field is 4 byte floating point

    var x, y, z;
    var off = 0;
    for(var i = 0 ; i < numPoints ; i++) {
        x = buffer[off];
        y = buffer[off + 1];
        z = buffer[off + 2];

        // x needs to be reflected
        if (normalize) {
            x = -x;
        }
        else {
            x = worldBoundsX[1] - x + worldBoundsX[0];
        }

        buffer[off] = x;   // negate x
        buffer[off + 1] = z;   // y is actually z from point cloud
        buffer[off + 2] = y;   // z is actually y from point cloud

        off += step;
    }
}

function fieldOffsetInSchema(schema, fieldName) {
    var lcase = fieldName.toLowerCase();
    for (var i = 0, il = schema.length ; i < il ; i ++) {
        if (schema[i].name && schema[i].name.toLowerCase() === lcase) {
            return i;
        }
    }
    return -1;
}

function collectStats(buffer, pointSize, numPoints, collectFor) {
    // We collect stats here, collectFor is a list of 3-tuples, where
    // each element specifies the stats to collect, first item being the
    // key and the second one being its offset in floating point in the point representation
    // and the third item being the clamp step
    //
    //
    // E.g. to collect Z-stats you'd say
    // collectFor = [["z" 1]];
    //
    var bins = {};

    var binIt = function(type, step, val) {
        var key = Math.floor(val / step) * step;
        var bin = bins[type] || {};
        bin[key] = ((!bin[key]) ? 0 : bin[key]) + 1;

        bins[type] = bin;
    };

    var offset = 0;
    var psInFloats = pointSize / 4;
    for (var i = 0 ; i < numPoints ; i ++) {
        for (var j = 0 ; j < collectFor.length ; j ++) {
            var type = collectFor[j][0],
                off  = collectFor[j][1],
                step = collectFor[j][2];

            var val = buffer[offset + off];
            binIt(type, step, val);
        }

        offset += psInFloats;
    }

    return bins;
}

var unpackEPTBuffer = function(buffer, totalPoints, pointSize, schema, sourceSchema, needBitFieldSizes) {
    var view = new DataView(buffer);
    var woff = 0;
    var roff = 0;

    // convert our schema into a bunch of function calls, this function is the same as
    // unpackBuffer but deals with newer variation of data type names
    //

    let fields = [];
    let setOfFields = new Set(schema.map(s => s.name));

    const quaterSizeFields = new Set(["ReturnNumber", "NumberOfReturns", "ScanDirectionFlag", "EdgeOfFlightLine"]);
    const fieldSizeOverrides = {"ScanAngleRank": 1};

    for (let i = 0 , il = sourceSchema.length, offset = 0; i < il ; i ++) {
        const s = sourceSchema[i];
        const fieldInfo = typeMappings[s.type];

        if (setOfFields.has(s.name)) {
            fields.push(fieldInfo.concat(offset));
        }

        let size = fieldInfo[0];
        if (needBitFieldSizes && quaterSizeFields.has(s.name)) size = 0.25;
        else if (needBitFieldSizes && fieldSizeOverrides[s.name] != null) size = fieldSizeOverrides[s.name];

        offset += size;
    }

    // from this point on, everything is stored as 32-bit floats
    const outBuffer = new Float32Array(totalPoints * schema.length);
    for (let i = 0 ; i < totalPoints ; i ++) {
        for (let j = 0, jl = fields.length ; j < jl ; j ++) {
            const [_, fn, offset] = fields[j];

            outBuffer[woff] = fn.call(view, roff + offset, true);
            woff ++;
        }
        roff += pointSize;
    }

    return outBuffer;
};

var unpackBuffer = function(buffer, totalPoints, pointSize, schema) {
    var view = new DataView(buffer);
    var woff = 0;
    var roff = 0;

    // convert our schema into a bunch of function calls
    //
    var fields = [];
    var computedPointSize = 0;
    for (var i = 0 ; i < schema.length ; i ++) {
        var s = schema[i];

        if (s.type === "floating" && s.size === 4)
            fields.push([4, DataView.prototype.getFloat32]);
        else if (s.type === "unsigned" && s.size === 4)
            fields.push([4, DataView.prototype.getUint32]);
        else if (s.type === "unsigned" && s.size === 2)
            fields.push([2, DataView.prototype.getUint16]);
        else if (s.type === "unsigned" && s.size === 1)
            fields.push([1, DataView.prototype.getUint8]);
        else if (s.type === "signed" && s.size === 4)
            fields.push([4, DataView.prototype.getInt32]);
        else if (s.type === "signed" && s.size === 2)
            fields.push([2, DataView.prototype.getInt16]);
        else if (s.type === "signed" && s.size === 1)
            fields.push([1, DataView.prototype.getInt8]);
        else
            throw Error("Unrecognized schema field: " + JSON.stringify(s));

        computedPointSize += s.size;
    }

    if (computedPointSize !== pointSize) {
        throw new Error("Point size validation failed, the schema size doesn't match computed point size");
    }

    // from this point on, everything is stored as 32-bit floats
    var outBuffer = new Float32Array(totalPoints * schema.length);

    for (var i = 0 ; i < totalPoints ; i ++) {
        for (var j = 0, jl = fields.length ; j < jl ; j ++) {
            var f = fields[j];

            var size = f[0];
            var fn = f[1];

            outBuffer[woff] = fn.call(view, roff, true);

            woff ++;
            roff += size;
        }
    }

    return outBuffer;
};

var applyScale = function(buffer, numPoints, schema, scale, offset) {
    var schemaX = fieldOffsetInSchema(schema, "x");
    var schemaY = fieldOffsetInSchema(schema, "y");
    var schemaZ = fieldOffsetInSchema(schema, "z");

    var pointSizeInFloats = schema.length;

    offset = (offset == null) ? [0, 0, 0] : offset;
    let poffset = 0;
    for (var i = 0, il = numPoints ; i < il ; i ++) {
        buffer[poffset + schemaX] = buffer[poffset + schemaX] * scale[0] + offset[0];
        buffer[poffset + schemaY] = buffer[poffset + schemaY] * scale[1] + offset[1];
        buffer[poffset + schemaZ] = buffer[poffset + schemaZ] * scale[2] + offset[2];

        poffset += pointSizeInFloats;
    }
}

var getColorChannelOffsets = function(schema) {
    var red = null, green = null, blue = null;

    schema.forEach(function(s, i) {
        if (s.name === "Red") red = i;
        else if (s.name === "Green") green = i;
        else if (s.name === "Blue") blue = i;
    });

    if (red !== null && green !== null && blue !== null)
        return [red, green, blue];

    return null;
};

var getIntensityOffset = function(schema) {
    var offset = null;
    schema.forEach(function(s, i) {
        if (s.name === "Intensity")
            offset = i;
    });

    return offset;
};

var decompressBufferGreyhound = function(schema, rawBuffer, numPoints, geoTransform) {
    var x = new Module.DynamicLASZip();

    var abInt = new Uint8Array(rawBuffer);
    var buf = Module._malloc(rawBuffer.byteLength);

    Module.HEAPU8.set(abInt, buf);
    x.open(buf, rawBuffer.byteLength);

    var pointSize = 0;
    var needUnpack = false;

    schema.forEach(function(f) {
        pointSize += f.size;
        if (f.type === "floating")
            x.addFieldFloating(f.size);
        else if (f.type === "unsigned") {
            x.addFieldUnsigned(f.size);
            needUnpack = true;
        }
        else if (f.type === "signed") {
            x.addFieldSigned(f.size);
            needUnpack = true;
        }
        else
            throw new Error("Unrecognized field desc:" + JSON.stringify(f));
    });

    var out = Module._malloc(numPoints * pointSize);
    for (var i = 0, offset = 0 ; i < numPoints ; i ++) {
        x.getPoint(out + offset);
        offset += pointSize;
    }

    var ret = new Uint8Array(numPoints * pointSize);
    ret.set(Module.HEAPU8.subarray(out, out + numPoints * pointSize));

    Module._free(out);
    Module._free(buf);

    x.delete();

    // we only need to unpack buffer if we have any non-floating point items in schema
    //
    var b = needUnpack ?
        unpackBuffer(ret.buffer, numPoints, pointSize, schema) :
        new Float32Array(ret.buffer);

    // the point size beyond this point has probably been updated, if the unpack happened we
    // our point size is now different than what it was before, its always going to be
    // 4 bytes per components since everything is converted to floats.
    //
    pointSize = schema.length * 4;

    // if we have scale and offset specified for this point buffer, apply that now,
    // NOTE THAT, we apply scaling and offset before we do the space swap since offset and scale are in
    // tree coordinate space
    //
    const scale = geoTransform.scale;
    if (scale[0] != 1.0 || scale[1] != 1.0 || scale[2] != 1.0) {
        applyScale(b, numPoints, schema, scale);
    }

    // if we got any points, swap them
    const treeSpaceWorldBounds = geoTransform.coordinateSpaceBounds('tree');
    if (numPoints > 0)
        swapSpace(b, [treeSpaceWorldBounds[0], treeSpaceWorldBounds[3]],
            pointSize, numPoints, true);


    // stats collection, if we have color, collect color stats
    //
    var statsToCollect = [
        ["z", 1, 10]
    ];

    var colorOffsets = getColorChannelOffsets(schema);

    if (colorOffsets !== null) {
        statsToCollect.push(["red", colorOffsets[0], 10]);
        statsToCollect.push(["green", colorOffsets[1], 10]);
        statsToCollect.push(["blue", colorOffsets[2], 10]);
    }

    var intensityOffset = getIntensityOffset(schema);
    if (intensityOffset !== null) {
        statsToCollect.push(["intensity", intensityOffset, 10]);
    }

    var stats = collectStats(b, pointSize, numPoints, statsToCollect);

    return [b, stats, numPoints];
};

function readAs(buf, Type, offset, count) {
    count = (count === undefined || count === 0 ? 1 : count);
    var sub = buf.slice(offset, offset + Type.BYTES_PER_ELEMENT * count);

    var r = new Type(sub);
    if (count === undefined || count === 1)
        return r[0];

    var ret = [];
    for (var i = 0 ; i < count ; i ++) {
        ret.push(r[i]);
    }

    return ret;
}

function parseLASHeader(arraybuffer) {
    var o = {};

    o.pointsOffset = readAs(arraybuffer, Uint32Array, 32*3);
    o.pointsFormatId = readAs(arraybuffer, Uint8Array, 32*3+8) & 0x3f;
    o.pointsStructSize = readAs(arraybuffer, Uint16Array, 32*3+8+1);

    o.extraBytes = 0;
    switch (o.pointsFormatId) {
        case 0: o.extraBytes = o.pointsStructSize - 20; break;
        case 1: o.extraBytes = o.pointsStructSize - 28; break;
        case 2: o.extraBytes = o.pointsStructSize - 26; break;
        case 3: o.extraBytes = o.pointsStructSize - 34; break;
    }

    o.pointsCount = readAs(arraybuffer, Uint32Array, 32*3 + 11);

    var start = 32*3 + 35;
    o.scale = readAs(arraybuffer, Float64Array, start, 3); start += 24; // 8*3
    o.offset = readAs(arraybuffer, Float64Array, start, 3); start += 24;

    var bounds = readAs(arraybuffer, Float64Array, start, 6); start += 48; // 8*6;
    o.maxs = [bounds[0], bounds[2], bounds[4]];
    o.mins = [bounds[1], bounds[3], bounds[5]];

    return o;
}

var decompressBufferLazFile = function(schema, sourceSchema, rawBuffer, numPoints, geoTransform) {
    var instance = new Module.LASZip();
    var abInt = new Uint8Array(rawBuffer);
    var buf = Module._malloc(rawBuffer.byteLength);

    instance.arraybuffer = rawBuffer;
    instance.buf = buf;

    Module.HEAP8.set(abInt, buf);
    instance.open(buf, rawBuffer.byteLength);

    const header = parseLASHeader(rawBuffer);
    const needUnpack = schema.some(f => f.type !== "float");

    let pointSize = header.pointsStructSize;
    numPoints = header.pointsCount;

    const out = Module._malloc(numPoints * pointSize);
    for (let i = 0, offset = 0 ; i < numPoints ; i ++) {
        instance.getPoint(out + offset);
        offset += pointSize;
    }

    const ret = new Uint8Array(numPoints * pointSize);
    ret.set(Module.HEAPU8.subarray(out, out + numPoints * pointSize));

    Module._free(out);
    Module._free(buf);

    instance.delete();

    // we only need to unpack buffer if we have any non-floating point items in schema
    //
    const b = needUnpack ?
        unpackEPTBuffer(ret.buffer, numPoints, pointSize, schema, sourceSchema, true) :
        new Float32Array(ret.buffer);

    // the point size beyond this point has probably been updated, if the unpack happened we
    // our point size is now different than what it was before, its always going to be
    // 4 bytes per components since everything is converted to floats.
    //
    pointSize = schema.length * 4;

    // if we have scale and offset specified for this point buffer, apply that now,
    // NOTE THAT, we apply scaling and offset before we do the space swap since offset and scale are in
    // tree coordinate space
    //
    // make sure the scale applied is from the LAZ file, for offset we need to account for the file's individual
    // offset and the point cloud offset
    const scale = header.scale;

    const offset = [];
    const geoOffset = geoTransform.offset;
    const fileOffset = header.offset;
    offset[0] = fileOffset[0] - geoOffset[0];
    offset[1] = fileOffset[1] - geoOffset[1];
    offset[2] = fileOffset[2] - geoOffset[2];

    if (scale[0] != 1.0 || scale[1] != 1.0 || scale[2] != 1.0) {
        applyScale(b, numPoints, schema, scale, offset);
    }

    // if we got any points, swap them
    const treeSpaceWorldBounds = geoTransform.coordinateSpaceBounds('tree');
    if (numPoints > 0)
        swapSpace(b, [treeSpaceWorldBounds[0], treeSpaceWorldBounds[3]],
            pointSize, numPoints, true);


    // stats collection, if we have color, collect color stats
    //
    var statsToCollect = [
        ["z", 1, 10]
    ];

    var colorOffsets = getColorChannelOffsets(schema);

    if (colorOffsets !== null) {
        statsToCollect.push(["red", colorOffsets[0], 10]);
        statsToCollect.push(["green", colorOffsets[1], 10]);
        statsToCollect.push(["blue", colorOffsets[2], 10]);
    }

    var intensityOffset = getIntensityOffset(schema);
    if (intensityOffset !== null) {
        statsToCollect.push(["intensity", intensityOffset, 10]);
    }

    var stats = collectStats(b, pointSize, numPoints, statsToCollect);

    return [b, stats, header.pointsCount];
};

var decompressBufferEPTBinary = function(schema, sourceSchema, rawBuffer, numPoints, geoTransform) {
    let pointSize = 0;
    let needUnpack = false;

    sourceSchema.forEach(function(f) {
        const fieldInfo = typeMappings[f.type];
        if (!fieldInfo)
            throw new Error("Unrecognized field desc:" + JSON.stringify(f));

        pointSize += fieldInfo[0];
        if (f.type !== 'float') needUnpack = true;
    });

    // For raw binary buffer, number of points is payload size/schema size
    numPoints = rawBuffer.byteLength / pointSize;

    // we only need to unpack buffer if we have any non-floating point items in schema
    //
    const b = needUnpack ?
        unpackEPTBuffer(rawBuffer, numPoints, pointSize, schema, sourceSchema) :
        new Float32Array(rawBuffer);

    // the point size beyond this point has probably been updated, if the unpack happened we
    // our point size is now different than what it was before, its always going to be
    // 4 bytes per components since everything is converted to floats.
    //
    pointSize = schema.length * 4;

    // if we have scale and offset specified for this point buffer, apply that now,
    // NOTE THAT, we apply scaling and offset before we do the space swap since offset and scale are in
    // tree coordinate space
    //
    // make sure the scale applied is from the LAZ file, for offset we need to account for the file's individual
    // offset and the point cloud offset
    const scale = geoTransform.scale;
    const offset = [0, 0, 0];

    if (scale[0] != 1.0 || scale[1] != 1.0 || scale[2] != 1.0) {
        applyScale(b, numPoints, schema, scale, offset);
    }

    // if we got any points, swap them
    const treeSpaceWorldBounds = geoTransform.coordinateSpaceBounds('tree');
    if (numPoints > 0)
        swapSpace(b, [treeSpaceWorldBounds[0], treeSpaceWorldBounds[3]],
            pointSize, numPoints, true);


    // stats collection, if we have color, collect color stats
    //
    let statsToCollect = [
        ["z", 1, 10]
    ];

    let colorOffsets = getColorChannelOffsets(schema);

    if (colorOffsets !== null) {
        statsToCollect.push(["red", colorOffsets[0], 10]);
        statsToCollect.push(["green", colorOffsets[1], 10]);
        statsToCollect.push(["blue", colorOffsets[2], 10]);
    }

    let intensityOffset = getIntensityOffset(schema);
    if (intensityOffset !== null) {
        statsToCollect.push(["intensity", intensityOffset, 10]);
    }

    let stats = collectStats(b, pointSize, numPoints, statsToCollect);

    return [b, stats, numPoints];
};

function transformSchemaFields(schema) {
    return schema.map(s => {
        if (s.type == 'floating') {
            return {
                type: 'signed',
                name: s.name,
                size: s.size
            }
        }

        // unchanged
        return s;
    })
}


const storageExtensionMapping = {
    'laszip': '.laz',
    'binary': '.bin'
};


function processTask(task) {
    let {
        server, resource,
        schema, sourceSchema,
        bounds, depthBegin, depthEnd,
        fullGeoBounds, scale, offset,
        allowCreds, filter, eptRootUrl, eptKey, eptDataStorage
    } = task;

    // should we do the EPT load or do our regular processing?
    let baseUrl = null;
    let qs = {};
    let postProcessorFn = null;
    let nostrip = false;

    const geoTransform = new GeoTransform(fullGeoBounds, scale, offset);
    const transformedSchema = transformSchemaFields(schema);

    if (eptRootUrl && eptKey && eptDataStorage) {
        //
        const ext = storageExtensionMapping[eptDataStorage];
        if (!ext) throw new Error('Cannot process data with unknown EPT storage.');
        baseUrl = joinPath(eptRootUrl, eptKey + ext);

        // for now both supported EPT backends (LAZ and Binary) need no number of points stripping
        // i.e. number of points delivered as the last 4 bytes of the payload
        nostrip = true;
        if (eptDataStorage === "laszip") {
            postProcessorFn = (data) => decompressBufferLazFile(transformedSchema, sourceSchema,
                data.response, data.numPoints, geoTransform);
        }
        else {
            postProcessorFn = (data) => decompressBufferEPTBinary(transformedSchema, sourceSchema,
                data.response, data.numPoints, geoTransform )
        }
    }
    else {
        baseUrl = joinPath(pickOne(server), 'resource', resource, 'read');
        qs = {
            schema: transformedSchema,
            bounds: bounds,
            depthBegin: depthBegin,
            depthEnd: depthEnd,
            compress: true,
            scale: scale,
            offset: offset,
        };

        if (filter) qs.filter = filter;
        postProcessorFn = (data) => decompressBufferGreyhound(transformedSchema, data.response, data.numPoints, geoTransform);
    }

    return getBinary(baseUrl, qs, {creds: allowCreds, nostrip: nostrip})
        .then(data => {
            const [buffer, stats, numPoints] = postProcessorFn(data);
            return {
                buffer: buffer,
                numPoints: numPoints,
                stats: stats
            };
        });
}

const pipeline = new BufferDownloadPipeline();

self.Module = {};
self.Module['onRuntimeInitialized'] = function() {
    console.log("Worker runtime is ready.");
    pipeline.markReady();
};

if (false) {
    console.log ("Worker: using webassembly laz-perf module.");
    importScripts("laz-perf.js");
}
else {
    console.log ("Worker: using asm.js laz-perf module.");
    importScripts("laz-perf.asm.js");
}

onmessage = (event) => {
    const data = event.data;

    const requestId = data.id;
    const task = data.task;

    task.id = requestId;
    pipeline.queue(task);
};