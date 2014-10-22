// gh-profiles.js
// Greyhound data fetch profiles
//

var gh = require("greyhound.js"),
    EventEmitter = require("events").EventEmitter;

var QuadTreePolicy = function(renderer, server, pipelineId) {
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

QuadTreePolicy.prototype.start = function() {
    var e = new EventEmitter();
    var reader = new gh.GreyhoundReader(this.server);
    var dataPushed = false;
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

            o.renderer.addPropertyListener(["view", "eye"], function(pos) {
                if (pos === null)
                    return;

                if (dataPushed) {
                    return;
                }

                dataPushed = true;

                e.emit("update", pos);
                var schema =
                    gh.Schema.XYZ()
                    .Red("floating", 4).Green("floating", 4).Blue("floating", 4)
                    .Intensity("floating", 4);

                schema.push({name: "Classification", type: "floating", size: 4});

                console.log("Querying with schema:", JSON.stringify(schema, null, "    "));

                // make sure our quad tree stuff
                reader.read(sessionId, {
                    schema: schema,
                    bbox: bbox,
                    depthStart: 0,
                    depthEnd: 9
                }, function(err, data) {
                    console.log("Read complete", err, data);
                    ppoint(data.data, 0);
                    if (err) return e.emit("error", err);
                    console.log("Added data!");
                    o.renderer.addPointBuffer("buff", new Float32Array(data.data.buffer));
                });
            });
        });
    });

    return e;
};


module.exports = {
    QuadTreePolicy: QuadTreePolicy
};

