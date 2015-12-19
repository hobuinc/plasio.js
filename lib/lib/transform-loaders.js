// transform-loaders.js
// Loaders for different kinds of transforms
//

var TransformLoader = function() {
};

TransformLoader.key = "transform";
TransformLoader.provides = "transform";

TransformLoader.prototype.queryFor = function(params) {
    return {
        position: params.worldBBox.center(),
        offset: params.normalize? params.worldBBox.center() : params.pointCloudBBox.center(),
        mins: params.worldBBox.mins,
        maxs: params.worldBBox.maxs,
        normalize: params.normalize
    };
};

TransformLoader.load = function(params, cb) {
    // don't really need sync loading
    cb(null, params);
};

module.exports = {
    TransformLoader: TransformLoader
};
