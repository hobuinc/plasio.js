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


var GHID = {
    toId: function(o) {
        var w = {}
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

var GreyhoundLoader = function() {
    // each loader needs a key
    this.key = "greyhound";
    this.pipelines = {};
};


GreyhoundLoader.prototype._withSession = function(host, pipelineId, cb) {
    if (this.pipelines[pipelineId])
        return process.nextTick(cb.bind(null, null, this.pipelines[pipelineId]));


    // we don't have that session id, craete it
    var r = new gh.GreyhoundReader(host);
    var o = this;

    r.createSession(pipelineId, function(err, sessionId) {
        if (err) return process.nextTick(err.bind(null, err));

        o.pipelines[pipelineId] = sessionId;
        cb(null, sessionId);
    });
};


GreyhoundLoader.prototype.load = function(id, cb) {
    var specs = GHID.fromId(id);

    var host = specs.host + ":" + specs.port;
    var pipelineId = specs.pipelineId;

    //console.log("Load request:", id, specs);

    var o = this;

    this._withSession(host, pipelineId, function(err, session) {
        if (err) return cb(err);

        var r = new gh.GreyhoundReader(host);
        r.read(session, specs, function(err, data) {
            if (err) return cb(err);

            cb(null, new Float32Array(data.data.buffer));
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
    this.center = vec3.add(vec3.create(),
                           vec3.subtract(vec3.create(),
                                         this.worldBBox.maxs, this.worldBBox.mins), this.worldBBox.mins);
    this.baseDepth = (defaultStartDepth || 6);
    this.depth = this.baseDepth;

    this.cellStack = [[0, this.baseDepth]];

    this.maxDist = geodist(allBBox.mins, allBBox.maxs);
    this.maxDepthLevel = 10;
    this.currentDownloadId = null;

    console.log(this.maxDist);

    // queue the base volume
    this.addBuffer({bbox: bbox, depthBegin: 0, depthEnd: this.baseDepth});
}

Cell.prototype.addBuffer = function(query) {
    query.pipelineId = this.pipelineId;
    query.host = this.reader.getHost();
    query.port = this.reader.getPort();
    query.schema = this.schema;


    var id = GHID.toId(query);

    //console.log("Adding:", id);
    this.renderer.addPointBuffer(id);
}

Cell.prototype.removeBuffer = function(query) {
    query.pipelineId = this.pipelineId;
    query.host = this.reader.getHost();
    query.port = this.reader.getPort();
    query.schema = this.schema;

    var id= GHID.toId(query);

    console.log("Removing:", id);
    this.renderer.removePointBuffer(id);
}

Cell.prototype.updateCell = function(eye) {
    var d = geodist(this.center, eye);
    var dn = d / this.maxDist;

    var neededDepth = this.baseDepth + Math.floor(Math.max(1.0 - dn, 0.0) * (this.maxDepthLevel - this.baseDepth));

    var o = this;

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


        this.addBuffer(query)
        this.cellStack.push([o.depth, neededDepth]);

        this.depth = neededDepth;
    }
    else {
        // keep removing stuff from the stack till we get to our needed resolution.

        var s = this.cellStack;
        while(s.length > 0) {
            var r = s[s.length - 1],
                l = r[0], h = r[1];

            if (l > neededDepth) {
                // this block's low point is above us, this buffer needs to go
                this.removeBuffer({
                    bbox: this.bbox,
                    depthBegin: l,
                    depthEnd: h
                });

                s.pop(); // get rid of this block
                continue; // move on the next one and check that
            }

            // the low point is below us, we need to check if this buffer needs to stay
            // or go, if the high point is above us, the buffer needs to go
            //
            if (h > neededDepth) {
                // this buffer needs to go
                this.removeBuffer({
                    bbox: this.bbox,
                    depthBegin: l,
                    depthEnd: h
                });

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

            this.addBuffer(q);
            this.cellStack.push([o.depth, neededDepth]);

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

            o.renderer.addPropertyListener(["view", "eye"], function(pos) {
                if (pos === null)
                    return;

                // patch eye position to match our transform in shader
                var a = pos[1];
                pos[0] = -pos[0];
                pos[1] = pos[2];
                pos[2] = a;

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
    NodeDistancePolicy: NodeDistancePolicy,
    GreyhoundLoader: GreyhoundLoader
};

