// transform-loaders.js
// Loaders for different kinds of transforms
//

let vec3 = require('gl-matrix').vec3;

import * as util from "./util";

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
        const renderSpaceBounds = util.checkParam(params, 'renderSpaceBounds');
        const boundsCenter = util.boundsCenter(renderSpaceBounds);

        return {
            position: boundsCenter,
            offset: boundsCenter,
            mins: renderSpaceBounds.slice(0, 3),
            maxs: renderSpaceBounds.slice(3),
            normalize: true
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
