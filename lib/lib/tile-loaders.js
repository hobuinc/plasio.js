// tile-loaders.js
// A whole bunch of tile loaders
//

var KittyLoader = function() {
};

KittyLoader.key = "kitty-loader";
KittyLoader.provides = "image-overlay";


KittyLoader.prototype.queryFor = function() {
    return {
        size: 512
    };
};

KittyLoader.load = function(params, cb) {
    var s = params.size;
    
    var url = "https://placekitten.com/" + s + "/" + s;
    
    var img = new Image();
    img.crossOrigin = '';
    img.onload = function() {
        cb(null, img);
    };

    img.src = url;
};


module.exports = {
    KittyLoader: KittyLoader
};
