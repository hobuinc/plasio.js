// gh-profiles.js
// Greyhound data fetch profiles
//

var gh = require("greyhound.js"),
    EventEmitter = require("events").EventEmitter,
    vec3 = require("gl-matrix").vec3,
    vec2 = require("gl-matrix").vec2,

    util = require("./util");


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

var Loader = function() {
    // each loader needs a key
    this.key = "greyhound";
    this.pipelines = {};
};


Loader.prototype._withSession = function(host, pipelineId, cb) {
    if (this.pipelines[pipelineId])
        return process.nextTick(cb.bind(null, null, this.pipelines[pipelineId]));


    // we don't have that session id, craete it
    var r = new gh.GreyhoundReader(host);
    var o = this;

    return r.createSession(pipelineId, function(err, sessionId) {
        if (err) return process.nextTick(err.bind(null, err));

        o.pipelines[pipelineId] = sessionId;
        return cb(null, sessionId);
    });
};


Loader.prototype.load = function(id, cb) {
    var specs = GHID.fromId(id);

    var host = specs.host + ":" + specs.port;
    var pipelineId = specs.pipelineId;

    var o = this;

    this._withSession(host, pipelineId, function(err, session) {
        if (err) return cb(err);

        var r = new gh.GreyhoundReader(host);
        return r.read(session, specs, function(err, data) {
            if (err) return cb(err);
            return cb(null, new Float32Array(data.data.buffer));
        });
    });
};

var Cell = function(reader, schema, pipelineId, renderer, allBBox, bbox, globalOffset, defaultStartDepth) {
    this.reader = reader;
    this.schema = schema;
    this.pipelineId = pipelineId;
    this.renderer = renderer;
    this.bbox = bbox;
    this.worldBBox = bbox.offsetBy(globalOffset);

    this.gcenter = util.geocenter(this.worldBBox);
    
    this.baseDepth = (defaultStartDepth || 6);
    this.depth = this.baseDepth;

    this.stack = [];

    this.maxDist = util.geodist(allBBox.mins, allBBox.maxs);
    this.maxDepthLevel = 12;

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

    return Math.max(0, Math.min(1 + Math.log(x) / df, 1.0));
};

Cell.prototype.updateCell = function(eye, target) {
    var o = this;

    var et = vec3.distance(target, eye); // the distance between the eye and the target

    // df goes from 1 -> 3
    var df = util.clamp(3 * (1.0 - et / o.maxDist), 1, 3); // df goes from 1 -> 3 based on how far 
    var dist = util.geodist(this.gcenter, target);

    console.log(dist, o.maxDist);

    // figure out what the depth needs to be, see debug.js on more details about this
    //
    var dist_f = Math.min(1, dist / o.maxDist);
    console.log(dist_f, df);
    
    dist_f = falloff(dist_f, df);
    var h = Math.floor(o.maxDepthLevel * Math.max(1.0 - dist_f, 0));

    console.log("---> ", h, o.depth);

    if (h === o.depth)
        return; // nothing to do here

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
        while(o.depth <= h) {
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
};

NodeDistancePolicy.prototype.start = function() {
    var e = new EventEmitter();
    var reader = new gh.GreyhoundReader(this.server);
    var o  = this;

    reader.createSession(this.pipelineId, function(err, sessionId) {
        if (err) return e.emit("error", err);

        // let emitter know that we could open the session and that we're starting
        // to observe stuff
        //
        e.emit("open", sessionId);

        return reader.getStats(sessionId, function(err, stats) {
            if (err) return e.emit("error", err);

            console.log("Got stats", stats);

            // got stats, make sure our bbox knows about this
            bbox = stats.bbox();
            e.emit("bbox", bbox);

            var boxes = splitTillDepth(bbox, 2);

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

            return o.renderer.addPropertyListener(["view"], function(view) {
                var eye = view.eye;
                var target = view.target;
                
                if (eye === null || target === null)
                    return;

                cells.forEach(function(c) {
                    c.updateCell(eye, target);
                });
            });
        });
    });

    return e;
};


module.exports = {
    NodeDistancePolicy: NodeDistancePolicy,
    Loader: Loader
};

