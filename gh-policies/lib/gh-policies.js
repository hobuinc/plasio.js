// gh-profiles.js
// Greyhound data fetch profiles
//

var gh = require("greyhound.js"),
    EventEmitter = require("events").EventEmitter,
    vec3 = require("gl-matrix").vec3,
    vec2 = require("gl-matrix").vec2;


var geodist = function(a, b) {
    return vec2.distance(a, b);
};

var Cell = function(id, downloadQueue, renderer, allBBox, bbox, globalOffset, defaultStartDepth) {
    this.id = id;
    this.downloadQueue = downloadQueue;
    this.renderer = renderer;
    this.bbox = bbox;
    this.worldBBox = bbox.offsetBy(globalOffset);
    this.center = vec3.add(vec3.create(), vec3.subtract(vec3.create(), this.worldBBox.maxs, this.worldBBox.mins), this.worldBBox.mins);
    this.baseDepth = (defaultStartDepth || 8);
    this.depth = this.baseDepth;

    this.cellStack = [[0, this.baseDepth]];

    this.maxDist = geodist(allBBox.mins, allBBox.maxs);
    this.maxDepthLevel = 12;
    this.currentDownloadId = null;

    console.log(this.maxDist);

    // queue the base volume
    this.downloadAndAdd(id + ":base", {bbox: bbox, depthEnd: this.baseDepth});
}

var CancellableQueue = function(reader, sessionId, schema, pfn) {
    this.reader = reader;
    this.sessionId = sessionId;
    this.schema = schema;
    this.readInProgress = false;
    this.tasks = [];
    this.pfn = pfn;
    this.readers = [];
    this.maxReaders = 15;
    for (var i = 0 ; i < this.maxReaders ; i ++) {
        this.readers.push(new gh.GreyhoundReader(reader.getHost() + ":" + reader.getPort()))
    }

    this.stats = { points: 0, bytes: 0};
};

CancellableQueue.id = 0;

CancellableQueue.prototype.cancel = function(id) {
    var t = this._findTask(id);

    if (t) {
        var f = t[3];
        console.log("Task cancelled");
        process.nextTick(f.bind(null, new Error("Was cancelled")));

        this._clearTask(id);
    }

    // TODO: Cancel any active read tasks
};

var niceQueue = function(tasks) {
    return tasks.map(function(q) {
        return q[0] + ":" + q[1] + "::" + (q[2].depthStart || 0) + "->" + q[2].depthEnd;
    }).join("    ");
};

CancellableQueue.prototype.queue = function(query, cb) {
    var id = CancellableQueue.id ++;
    console.log("Queing task:", query);

    var priority = this.pfn(query);
    this.tasks.push([priority, id, query, cb]);
    this.tasks.sort(function(a, b) {
        var p1 = a[0], p2 = b[0];
        return p1 - p2;
    });

    if(this.readers.length > 0) {
        // there are some free readers available
        this._processNextTask();
    }
};

CancellableQueue.prototype._clearTask = function(id) {
    this.tasks = this.tasks.filter(function(v) {
        return v[1] !== id;
    });
};

CancellableQueue.prototype._findTask = function(id) {
    // sup guys, 1996 calling.
    for(var i in this.tasks) {
        var t = this.tasks[i];
        if (t[1] === id)
            return t;
    }

    return null;
}

CancellableQueue.prototype._processNextTask = function() {
    if (this.tasks.length === 0) {
        return; // all done
    }


    // if there are no more readers left, just leave, one of the completions will re-trigger this code
    //
    if (this.readers.length === 0) {
        console.warn("No readers, will wait for task to finish");
        return;
    }

    // otherwise work with these reader
    var reader = this.readers.pop();

    console.log("reader acquired", this.readers.length);


    var t = this.tasks[0];
    var id = t[1],
        query = t[2],
        cb = t[3];

    // delete current task so the user just can't remove it and feel
    // that its cancelled
    this._clearTask(id);

    var o = this;

    query.schema = query.schema || this.schema;
    reader.read(this.sessionId, query, function(err, data) {
        o.stats.points += data.numPoints;
        o.stats.bytes += data.numBytes;

        // this request finished processing
        console.log("finished processing:", query, "stats", o.stats);

        // return the reader back to the pool
        o.readers.push(reader);

        // schedule next task
        process.nextTick(function() {
            o._processNextTask();
        });

        // notify about data
        cb(err, data);
    });
}

var getCached = (function() {
    var cache = {};
    var ctotal = 0;

    return function(queue, qid, query, cb) {
        console.log("gc!", qid);
        if (cache[qid]) {
            console.log("qh!:", qid);
            return setTimeout(cb.bind(null, null, cache[qid]));
        }

        queue.queue(query, function(err, data) {
            if (err) return cb(err);
            ctotal += data.data.length;
            console.log("qs!:", qid, data.data.length, "bytes", ctotal, "cached");

            cache[qid] = data;
            cb(null, data);
        });
    };

})();

Cell.prototype.downloadAndAdd = function(qid, query, fdone) {
    // if there's a download in progress, cancel it
    if (this.currentDownloadId !== null) {
        this.downloadQueue.cancel(this.currentDownloadId);
        this.currentDownloadId = null;
    }

    // now requeue the new download
    var o = this;
    this.currentDownloadId = this.downloadQueue.queue(query, function(err, data) {
        // got data, add it in
        o.currentDownloadId = null;
        o.renderer.addPointBuffer(qid, new Float32Array(data.data.buffer));

        if (fdone)
            process.nextTick(fdone);
    });
}

Cell.prototype.updateCell = function(eye) {
    var d = geodist(this.center, eye);
    var dn = d / this.maxDist;

    var neededDepth = this.baseDepth + Math.floor(Math.max(1.0 - dn, 0.0) * (this.maxDepthLevel - this.baseDepth));

    var o = this;

    var qid = function(s, e) {
        return o.id + ":" + s + "->" + e;
    }

    if (neededDepth === this.depth)
        return; // we are at the depth we need to be

    var queuedDepth = (this.cellStack.length > 0) ?
        this.cellStack[this.cellStack.length - 1][1] : 0;

    if (neededDepth > queuedDepth) {
        // find the step which will satisfy the depth requirement
        var query = {
            bbox: this.bbox,
            depthBegin: this.depth,
            depthEnd: neededDepth
        };


        var id = qid(this.depth, neededDepth);
        this.downloadAndAdd(id, query, function() {
            o.cellStack.push([o.depth, neededDepth]);
        });

        o.depth = neededDepth;
    }
    else {
        // keep removing stuff from the stack till we get to our needed resolution.

        var s = this.cellStack;
        while(s.length > 0) {
            var r = s[s.length - 1],
                l = r[0], h = r[1];

            if (l > neededDepth) {
                // this block's low point is above us, this buffer needs to go
                this.renderer.removePointBuffer(qid(l, r));

                s.pop(); // get rid of this block
                continue; // move on the next one and check that
            }

            // the low point is below us, we need to check if this buffer needs to stay
            // or go, if the high point is above us, the buffer needs to go
            //
            if (h > neededDepth) {
                // this buffer needs to go
                this.renderer.removePointBuffer(qid(l, r));
                s.pop();
            }

            // now push the new buffer
            // TODO: just directly pushing a full size buffer is often not a good idea.
            //
            var start = (s.length === 0) ? 0 : s[s.length-1][1];

            if (start === neededDepth) // we have reached our target
                break;

            var q = {
                bbox: this.bbox,
                depthBegin: start,
                depthEnd: neededDepth
            };

            var qidd = qid(start, neededDepth);
            this.downloadAndAdd(qidd, q, function() {
                o.cellStack.push([o.depth, neededDepth]);
            });

            this.depth = neededDepth;
            break;
        }
    }
}



var NodeDistancePolicy = function(renderer, server, pipelineId) {
    this.renderer = renderer;
    this.server = server;
    this.pipelineId = pipelineId;
};

var ppoint = function(data, idx) {
    var f = new Float32Array(data.buffer);
    var off = idx * 8;
    console.log("x:", f[0], "y:", f[1], "z:", f[2],
                "r:", f[3], "g:", f[4], "b:", f[5],
                "i:", f[6], "c:", f[7]);
};

var splitTillDepth = function(bbox, depth) {
    var split = function(b, d) {
        console.log(b);
        var bxs = b.splitQuad();
        if (depth === d) return bxs;

        return [].concat(split(bxs[0], d + 1),
                         split(bxs[1], d + 1),
                         split(bxs[2], d + 1),
                         split(bxs[3], d + 1));
    };

    return split(bbox, 1);
}

NodeDistancePolicy.prototype.start = function() {
    var e = new EventEmitter();
    var reader = new gh.GreyhoundReader(this.server);
    var o  = this;

    reader.createSession(this.pipelineId, function(err, sessionId) {
        if (err) return e.emit("error", err);

        // let emitter know that we could open the session and that we're starting
        // to observe stuff
        e.emit("open", sessionId);

        reader.getStats(sessionId, function(err, stats) {
            if (err) return e.emit("error", err);

            console.log("Got stats", stats);

            // got stats, make sure our bbox knows about this
            bbox = stats.bbox();
            e.emit("bbox", bbox);

            console.log("Have bounding box", bbox);

            var boxes = splitTillDepth(bbox, 3);

            // Make sure the color range is setup fine
            var maxColorComponent = Math.max(
                stats.get("Red/maximum"),
                stats.get("Green/maximum"),
                stats.get("Blue/maximum")
            );

            console.log("Max color component:", maxColorComponent);
            o.renderer.setRenderOptions({
                maxColorComponent: maxColorComponent
            });

            var globalOffset = bbox.center();

            var schema =
                gh.Schema.XYZ()
                .Red("floating", 4).Green("floating", 4).Blue("floating", 4)
                .Intensity("floating", 4);
            schema.push({name: "Classification", type: "floating", size: 4});

            var readQueue = new CancellableQueue(reader, sessionId, schema, function(q) {
                return (q.depthBegin ?
                        (q.depthBegin + (q.depthEnd - q.depthBegin) / 2) :
                        q.depthEnd);
            });


            var cells = boxes.map(function(box, index) {
                return new Cell(index, readQueue, o.renderer, bbox, box, globalOffset);
            });

            o.renderer.addPropertyListener(["view", "eye"], function(pos) {
                if (pos === null)
                    return;

                // x is flipped
                pos[0] = -pos[0];

                e.emit("update", pos);

                // update cells as the eye moves around
                //
                cells.forEach(function(c) {
                    c.updateCell(pos);
                });
            });
        });
    });

    return e;
};


module.exports = {
    NodeDistancePolicy: NodeDistancePolicy
};

