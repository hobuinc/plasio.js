// gh-loader.js
// WebWorker loader for GH volumes, caches pipelines etc. as well
//

var gh = require("greyhound.js");


var pipelines = [];

var _withSession = function(host, pipelineId, cb) {
    if (pipelines[pipelineId])
        return process.nextTick(cb.bind(null, null, pipelines[pipelineId]));


    // we don't have that session id, create it
    var r = new gh.GreyhoundReader(host);
    return r.createSession(pipelineId, function(err, sessionId) {
        r.close();

        if (!err)
            pipelines[pipelineId] = sessionId;

        process.nextTick(cb.bind(null, err, sessionId));
    });
};


var load = function(specs, cb) {
    var host = specs.host + ":" + specs.port;
    var pipelineId = specs.pipelineId;

    _withSession(host, pipelineId, function(err, session) {
        if (err) return cb(err);

        var r = new gh.GreyhoundReader(host);
        return r.read(session, specs, function(err, data) {
            r.close();
            
            if (err) return cb(err);
            return cb(null, new Float32Array(data.data.buffer));
        });
    });
};

// Event handler which gets notification from the main thread
//
self.onmessage = function(evt) {
    // get any new requests for loading in volumes
    var specs = evt.data.specs;
    var id = evt.data.id;
    load(specs, function(err, data) {
        if (err) return self.postMessage({id: id, error: err});

        // We got thed ata, send the data over the reciever with buffer ownership
        //
        return self.postMessage({id: id, data: data}, [data.buffer]);
    });
};
