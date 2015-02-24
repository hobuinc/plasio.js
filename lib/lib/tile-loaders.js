// tile-loaders.js
// A whole bunch of tile loaders
//

var SphericalMercator = require("sphericalmercator");

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

var MapboxLoader = function() {
};

MapboxLoader.key = "mapbox-loader";
MapboxLoader.provides = "image-overlay";

var detailLevel = function(s, bbox) {
    // convert spherical to lat long
    //
    var l = s.inverse(bbox.slice(0, 2)).concat(s.inverse(bbox.slice(2)));

    // find a zoom factor for which we have a resonable number of times to fetch
    var z = 20;
    var range = null;
    while(z > 0) {
        range = s.xyz(l, z);
        var c = (range.maxX - range.minX) * (range.maxY - range.minY);
        if (c < 15)
            break;
        z --;
    }

    return {
        region: l,
        zoom: z,
        range: range
    };
};

var bboxCenter = function(b) {
    return [b[0] + (b[2] - b[0]) / 2, b[1] + (b[3] - b[1]) / 2];
};

var tilesForRegion = function(s, bbox) {
    // give a region, figure out all the tiles needed with their
    var v = detailLevel(s, bbox);

    var zoom  = v.zoom;
    var range = v.range;
    var region = v.region;

    var regionCenter = s.forward(bboxCenter(region));

    var tiles = [];

    for (var y = range.minY - 1 ; y <= range.maxY + 1 ; y ++) {
        for (var x = range.minX - 1 ; x <= range.maxX + 1 ; x++) {
            var b = s.bbox(x, y, zoom);
            var center = s.forward(bboxCenter(b));
            var tileBBox = s.forward(b.slice(0, 2)).concat(s.forward(b.slice(2, 4)));

            tiles.push({
                center: center,
                bbox: tileBBox,
                range: range,
                x: x,
                y: y,
                zoom: zoom,
                offset: [regionCenter[0] - center[0], regionCenter[1] - center[1]]
            });
        }
    }

    return tiles;
};

var fetchTile = function(tile, cb) {
    var url =
            "http://api.tiles.mapbox.com/v4/hobu.l8a69jch/" +
            tile.zoom + "/" +
            tile.x + "/" +
            tile.y + ".png" +
            "?access_token=pk.eyJ1IjoiaG9idSIsImEiOiItRUhHLW9NIn0.RJvshvzdstRBtmuzSzmLZw";

    var image = new Image();
    image.crossOrigin = '';

    image.onload = function() {
        cb(null, {tile: tile, image: image});
    };

    image.src= url;
};

var loadAllTiles = function(tiles, cb) {
    var imgs = [];

    for (var i in tiles) {
        var t = tiles[i];
        fetchTile(t, function(err, res) {
            imgs.push(res);
            if (imgs.length === tiles.length)
                cb(null, imgs);
        });
    }
};

var drawTilesToCanvas = function(ctx, bbox, tiles) {
    var rangex = bbox[2] - bbox[0];
    var rangey = bbox[3] - bbox[1];

    var ranges = rangex > rangey ? rangex : rangey;

    var f = 1024 / ranges;

    for (var i in tiles) {
        var t = tiles[i];

        var tileWidth = t.tile.bbox[2] - t.tile.bbox[0];
        var tileHeight = t.tile.bbox[3] - t.tile.bbox[1];

        tileWidth *= f;
        tileHeight *= f;

        var x = 512 + (- t.tile.offset[0] * f) - 128;
        var y = 512 + (t.tile.offset[1] * f) - 128;

        ctx.drawImage(t.image, x, y, tileWidth, tileHeight);
        ctx.fillText(t.tile.x + ", " + t.tile.y, x + tileWidth / 2, y + tileHeight / 2);
        ctx.rect(x, y, tileWidth, tileHeight);
        ctx.stroke();
    }
};


MapboxLoader.prototype.queryFor = function(bbox) {
    var box = bbox.mins.slice(0, 2).concat(bbox.maxs.slice(0, 2));
    return {
        bbox: box
    };
};

MapboxLoader.load = function(params, cb) {
    var bbox = params.bbox;
    var s = new SphericalMercator();
    
    var tiles = tilesForRegion(s, bbox);

    loadAllTiles(tiles, function(err, images) {
        var c = document.createElement("canvas");

        c.width = 1024;
        c.height = 1024;
        
        var ctx = c.getContext("2d");
        ctx.scale(-1, 1);
        drawTilesToCanvas(ctx, bbox, images);

        console.log("completing for", bbox);
        /*
        c.style.position = "absolute";
        c.style.left = 0;
        c.style.top = 0;
        c.style.width = 512;
        c.style.height = 512;
         */

        //document.body.appendChild(c);
        
        cb(null, {
            image: c,
            needFlip: true
        });
    });
};

module.exports = {
    KittyLoader: KittyLoader,
    MapboxLoader: MapboxLoader
};
