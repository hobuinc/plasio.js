// greyhound.js 
// Greyhound data fetch profiles
//

var gh = require("greyhound.js"),
    EventEmitter = require("events").EventEmitter,
    vec3 = require("gl-matrix").vec3,
    vec2 = require("gl-matrix").vec2,
    inherits = require('util').inherits,
    util = require("./util");

var TriggeredDispatch = require('./util').TriggeredDispatch;


var GHID = {
    toId: function(o) {
        var w = {};
        w.host = o.host;
        w.port = o.port;
        w.pipelineId = o.pipelineId;
        w.depthBegin = o.depthBegin;
        w.depthEnd = o.depthEnd;
        w.mins = o.bbox.mins;
        w.maxs = o.bbox.maxs;
        w.schema = o.schema;

        return "greyhound:" +
            JSON.stringify(w);
    },
    fromId: function(s) {
        var o = JSON.parse(s.substr(10)); // jump past greyhound:
        o.bbox = new gh.BBox(o.mins, o.maxs);
        return o;
    }
};

var ConnectionPool = function(max, emitter) {
    this.max = max;
    this.inuse = [];
    this.waiting = [];
    this.e = emitter || new EventEmitter();
};


ConnectionPool.prototype._emitStats = function() {
    var s = {
        inuse: this.inuse.length,
        waiting: this.waiting.length,
        max: this.max
    };

    this.e.emit("pool-stats", s);
};

ConnectionPool.prototype.acquire = function(f, cb) {
    var r;
    if (this.inuse.length < this.max) {
        // we have room to create more
        r = f();
        this.inuse.push(r);
        process.nextTick(cb.bind(null, null, r));
    }
    else {
        this.waiting.push(cb);
    }
   
    this._emitStats();
};


ConnectionPool.prototype.return = function(r) {
    if (this.waiting.length > 0) {
        var cb = this.waiting.pop();
        process.nextTick(cb.bind(null, null, r));
    }
    else {
        // no use for this connection, so get rid of it
        //
        r.close();
        this.inuse = this.inuse.filter(function(e) { return e !== r; });
    }

    this._emitStats();
};


var Loader = function() {
    // each loader needs a key
    this.key = "greyhound";
    this.pipelines = {};
    this.pools = {};
    this.stats = {totalPoints: 0, totalBytes: 0};
};

inherits(Loader, EventEmitter);

Loader.prototype._withSession = function(host, pipelineId, cb) {
    if (this.pipelines[pipelineId] === undefined) {
        this.pipelines[pipelineId] = [cb]; // list of all waiting callbacks

        var o = this;
        var triggerAll = function(err, v) {
            o.pipelines[pipelineId].forEach(function(f) {
                process.nextTick(f.bind(null, err, v));
            });
        };

        // we don't have that session id, create it
        var r = new gh.GreyhoundReader(host);

        r.createSession(pipelineId, function(err, sessionId) {
            r.close();

            if (err) {
                triggerAll(err);
                o.pipelines[pipelineId] = err;
            }
            else {
                triggerAll(null, sessionId);
                o.pipelines[pipelineId] = sessionId;
            }
        });
    }
    else if (Array.isArray(this.pipelines[pipelineId])) {
        this.pipelines[pipelineId].push(cb);
    }
    else if (this.pipelines[pipelineId] instanceof Error) {
        process.nextTick(cb.bind(null, this.pipelines[pipelineId]));
    }
    else {
        process.nextTick(cb.bind(null, null, this.pipelines[pipelineId]));
    }
};

Loader.prototype.load = function(id, cb) {
    var specs = GHID.fromId(id);

    var host = specs.host + ":" + specs.port;
    var pipelineId = specs.pipelineId;

    var o = this;

    // define the creation function in case a new object would need to be instantiated
    var cf = function() {
        return new gh.GreyhoundReader(host);
    };

    this._withSession(host, pipelineId, function(err, session) {
        if (err) return cb(err);

        if (!o.pools[session])
            o.pools[session] = new ConnectionPool(10, o);

        var p = o.pools[session];

        return p.acquire(cf, function(err, r) {
            r.read(session, specs, function(err, data) {
                p.return(r);

                o.stats.totalPoints += data.numPoints;
                o.stats.totalBytes += data.numBytes;

                o.emit("download-stats", o.stats);
            
                if (err) return cb(err);
                return cb(null, new Float32Array(data.data.buffer));
            });
        });
    });
};

var AsyncLoader = function() {
    this.key = "greyhound";
    this.workers = [];
    this.rrIndex = 0;
    this.queuedReads = {};
    this.nextQueueIndex = 0;

    var o = this;
    var _handleww = function(evt) {
        var d = evt.data;
        var qi = o.queuedReads[d.id];

        if (!qi)
            return console.log("recieved data for unknown request");

        delete o.queuedReads[d.id];

        var handler = qi;
        if (d.error)
            return handler(d.error);

        return handler(null, d.data);
    };
    
    var totalWorkers = 5;
    for(var i = 0; i < totalWorkers; i++) {
        var w = new Worker("/workers/gh-loader.js");
        w.onmessage = _handleww;
        this.workers.push(w);
    }
};

inherits(AsyncLoader, EventEmitter);

AsyncLoader.prototype.load = function(id, cb) {
    var w = this.workers[this.rrIndex++]; // choose a ww for this task
    if (this.rrIndex === this.workers.length)
        this.rrIndex = 0;

    var specs = GHID.fromId(id);
    this.queuedReads[id] = cb;

    w.postMessage({id: id, specs: specs });
};

var Cell = function(reader, schema, pipelineId, renderer, allBBox, bbox, globalOffset, defaultStartDepth) {
    this.reader = reader;
    this.schema = schema;
    this.pipelineId = pipelineId;
    this.renderer = renderer;
    this.bbox = bbox;
    this.worldBBox = bbox.offsetBy(globalOffset);

    this.gcenter = util.geocenter(this.worldBBox);
    
    this.baseDepth = (defaultStartDepth || 8);
    this.depth = this.baseDepth;

    this.maxDist = util.geodist(allBBox.mins, allBBox.maxs);
    this.maxDepthLevel = 14;

    // queue the base volume
    this.addBuffer({bbox: bbox, depthBegin: 0, depthEnd: this.baseDepth});
};


Cell.prototype.addBuffer = function(query) {
    query.pipelineId = this.pipelineId;
    query.host = this.reader.getHost();
    query.port = this.reader.getPort();
    query.schema = this.schema;


    var id = GHID.toId(query);

    this.renderer.addPointBuffer(id);
};

Cell.prototype.removeBuffer = function(query) {
    query.pipelineId = this.pipelineId;
    query.host = this.reader.getHost();
    query.port = this.reader.getPort();
    query.schema = this.schema;

    var id= GHID.toId(query);

    this.renderer.removePointBuffer(id);
};


var falloff = function(x, df) {
    // if x is very small, make sure its something valid
    if (Math.abs(x) < 0.0001)
        x = 0.00001 * Math.sign(x);

    // the falloff function is a blend of two functions, controlled by
    // the blending factor df
    //
    var f1 = 1 + Math.log(Math.max(0.00001, x - 0.01)) / 3;
    var f2 = 1 + Math.log(x);

    df = df * df * df;

    return f2 * df + f1 * (1 - df);
};

Cell.prototype.updateCell = function(eye, target) {
    var o = this;

    var et = vec3.distance(target, eye); // the distance between the eye and the target

    // df goes from 0 -> 1
    // when near the target, the value needs to be close to 0
    // when far from the target, the value needs to be close to 1
    //
    var df = util.clamp(et / o.maxDist, 0, 1); 
    var dist = util.geodist(this.gcenter, target);

    // figure out what the depth needs to be, see debug.js on more details about this
    //
    var dist_f = Math.min(1, dist / o.maxDist);
    
    var weight = falloff(dist_f, df);
    var h = Math.floor(o.baseDepth +
                       (o.maxDepthLevel - o.baseDepth) * (1 - weight)); 

    if (h === o.depth)
        return; // nothing to do here


    console.log("depth-shift:", o.depth, "->", h, "w:", weight, "dist_f:", dist_f, "dist:", dist);

    if (h < o.depth) {
        while (o.depth > h) {
            var qr = {
                bbox: o.bbox,
                depthBegin: h - 1,
                depthEnd: h
            };

            o.removeBuffer(qr);
            o.depth --;
        }
    }
    else {
        while(o.depth < h) {
            var qa = {
                bbox: o.bbox,
                depthBegin: o.depth,
                depthEnd: o.depth + 1
            };

            o.addBuffer(qa);
            o.depth ++;
        }
    }
};



var NodeDistancePolicy = function(renderer, server, pipelineId) {
    this.renderer = renderer;
    this.server = server;
    this.pipelineId = pipelineId;
};

inherits(NodeDistancePolicy, EventEmitter);

var ppoint = function(data, idx) {
    var f = new Float32Array(data.buffer);
    var off = idx * 8;
    console.log("x:", f[0], "y:", f[1], "z:", f[2],
                "r:", f[3], "g:", f[4], "b:", f[5],
                "i:", f[6], "c:", f[7]);
};

var splitTillDepth = function(bbox, depth) {
    var split = function(b, d) {
        var bxs = b.splitQuad();
        if (depth === d) return bxs;

        return [].concat(split(bxs[0], d + 1),
                         split(bxs[1], d + 1),
                         split(bxs[2], d + 1),
                         split(bxs[3], d + 1));
    };

    return split(bbox, 1);
};


NodeDistancePolicy.prototype.start = function() {
    var reader = new gh.GreyhoundReader(this.server);
    var o  = this;

    reader.createSession(this.pipelineId, function(err, sessionId) {
        if (err) return o.emit("error", err);

        // let emitter know that we could open the session and that we're starting
        // to observe stuff
        //
        o.emit("open", sessionId);

        return reader.getStats(sessionId, function(err, stats) {
            if (err) return o.emit("error", err);

            console.log("Got stats", stats);

            // got stats, make sure our bbox knows about this
            bbox = stats.bbox();
            o.emit("bbox", bbox);

            var boxes = splitTillDepth(bbox, 1);

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


            var cells = boxes.map(function(box, index) {
                return new Cell(reader, schema, o.pipelineId, o.renderer, bbox, box, globalOffset);
            });

            var trigger = new TriggeredDispatch(500, function(view) {
                if (!view)
                    return;
                
                var eye = view.eye;
                var target = view.target;
                
                if (eye === null || target === null)
                    return;

                cells.forEach(function(c) {
                    c.updateCell(eye, target);
                });
            });

            return o.renderer.addPropertyListener(["view"], function(view) {
                console.log("pushing");
                trigger.val(view);
            });
        });
    });
};


module.exports = {
    NodeDistancePolicy: NodeDistancePolicy,
    Loader: Loader,
    AsyncLoader: AsyncLoader
};

