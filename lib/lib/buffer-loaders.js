// buffer-loaders.js
// Load stuff from remote buffers
//

var util = require("./util");

var GreyhoundPipelineLoader = function(baseURL, pipelineId, maxDepth) {
    // each loader needs a key
    this.baseURL = baseURL;
    this.maxDepth = maxDepth || 12;
    this.pipelineId = pipelineId;

    // TODO: no schema overrides for now
    //
    this.schema = [{name: "X", type: "floating", size: 4},
                   {name: "Y", type: "floating", size: 4},
                   {name: "Z", type: "floating", size: 4}];
};

    
GreyhoundPipelineLoader.key = "greyhound";
GreyhoundPipelineLoader.provides = "point-buffer";

GreyhoundPipelineLoader.prototype.queryFor = function(treeBBox, depthBegin, depthEnd) {
    return {
        baseURL: this.baseURL,
        pipelineId: this.pipelineId,
        depthBegin: depthBegin,
        depthEnd: depthEnd,
        mins: treeBBox.mins,
        maxs: treeBBox.maxs,
        maxDepth: this.maxDepth,
        schema: this.schema
    };
};

GreyhoundPipelineLoader.load = function(params, cb) {
    console.log("LOAD REQUEST:", params);
    
    var baseURL = params.baseURL;
    var pipelineId = params.pipelineId;

    var schema = params.schema;
    var depthBegin = params.depthBegin || 0;
    var depthEnd = params.depthEnd || params.maxDepth;

    var bbox = [params.mins[0], params.mins[1], params.maxs[0], params.maxs[1]];
    
    var qs = "depthBegin=" + encodeURIComponent(JSON.stringify(depthBegin)) + "&" +
            "depthEnd=" + encodeURIComponent(JSON.stringify(depthEnd)) + "&" +
            "schema=" + encodeURIComponent(JSON.stringify(schema)) + "&" +
            "bbox=" + encodeURIComponent(JSON.stringify(bbox));

    var u = baseURL + "/pipeline/" + pipelineId + "/read?" + qs;

    util.getBinary(u, function(err, contentType, data) {
        if (err) return cb(err);
        var a = new Float32Array(data);

        return cb(null, a); 
    });
};


var GreyhoundStaticLoader = function(baseURL) {
    this.baseURL = baseURL;
};

GreyhoundStaticLoader.prototype.queryFor = function(treeBBox, depthBegin, depthEnd) {
    var s = JSON.stringify({
        mins: treeBBox.mins, maxs: treeBBox.maxs,
        depthBegin: depthBegin,
        depthEnd: depthEnd
    });

    var sha = createHash('sha1');
    sha.update(s);
    var h = sha.digest('hex');

    return h;
};

GreyhoundStaticLoader.load = function(params, cb) {
    var url = specs.baseURL + "/" + id;

    util.getBinary(url, true, function(err, contentType, data) {
        if (err) return cb(err);

        var a = new Float32Array(data);
        var pointCount = a.length / 8;


        if (params.debugColor) {
            var c = [parseInt(id.substring(0, 2), 16),
                     parseInt(id.substring(2, 4), 16),
                     parseInt(id.substring(4, 6), 16)];

            for (var i = 0 ; i < pointCount ; i++) {
                a[8*i + 3] = c[0];
                a[8*i + 4] = c[1];
                a[8*i + 5] = c[2];
            }
        }

        return cb(null, a); 
    });
};


module.exports = {
    GreyhoundPipelineLoader: GreyhoundPipelineLoader,
    GreyhoundStaticLoader: GreyhoundStaticLoader
};
