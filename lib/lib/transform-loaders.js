// transform-loaders.js
// Loaders for different kinds of transforms
//

let vec3 = require('gl-matrix').vec3;

var TransformLoader = function() {
};

TransformLoader.key = "transform";
TransformLoader.provides = "transform";

TransformLoader.prototype.queryFor = (function() {
    let p = [0, 0, 0],
        o = [0, 0, 0],
        n = [0, 0, 0],
        x = [0, 0, 0];
    
    return function(params) {
        var adjustmentOffset = params.adjustmentOffset || [0, 0, 0]
        return {
            position: vec3.add([0, 0, 0], params.worldBBox.center(), adjustmentOffset),
            offset: params.normalize? params.worldBBox.center() : params.pointCloudBBox.center(), // vec3.add(o, params.normalize? params.worldBBox.center() : params.pointCloudBBox.center(), adjustmentOffset),
            mins: params.worldBBox.mins, //vec3.add(params.worldBBox.mins, adjustmentOffset),
            maxs: params.worldBBox.maxs, //vec3.add(params.worldBBox.maxs, adjustmentOffset),
            normalize: params.normalize
        };
    };
})();

TransformLoader.load = function(params, cb) {
    // don't really need sync loading
    cb(null, params);
};

module.exports = {
    TransformLoader: TransformLoader
};
