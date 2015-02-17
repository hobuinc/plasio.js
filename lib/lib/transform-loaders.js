// transform-loaders.js
// Loaders for different kinds of transforms
//

var TransformLoader = function() {
};

TransformLoader.key = "transform";
TransformLoader.provides = "transform";

TransformLoader.prototype.queryFor = function(worldBBox, regionBBox) {
    return {
        position: worldBBox.center(),
        offset: regionBBox.center(),
        mins: worldBBox.mins,
        maxs: worldBBox.maxs
    };
};

TransformLoader.load = function(params, cb) {
    // don't really need sync loading
    cb(null, params);
};

module.exports = {
    TransformLoader: TransformLoader
};
