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
        if (c < 10)
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

    var regionCenter = bboxCenter(s.forward(region.slice(0, 2)).concat(s.forward(region.slice(2, 4))));

    var tiles = [];

    for (var y = range.minY ; y <= range.maxY ; y ++) {
        for (var x = range.minX ; x <= range.maxX ; x++) {
            var b = s.bbox(x, y, zoom);
            var tileBBox = s.forward(b.slice(0, 2)).concat(s.forward(b.slice(2, 4)));
            var center = bboxCenter(tileBBox);

            tiles.push({
                center: center,
                bbox: tileBBox,
                x: x,
                y: y,
                zoom: zoom,
                offset: [regionCenter[0] - center[0], regionCenter[1] - center[1]]
            });
        }
    }

    return tiles;
};

var fetchTile = function(tile, mapboxType, cb) {
    var url =
            "http://api.tiles.mapbox.com/v4/" +
            mapboxType + "/" +
            tile.zoom + "/" +
            tile.x + "/" +
            tile.y + ".jpg70" +
            "?access_token=pk.eyJ1IjoiaG9idSIsImEiOiItRUhHLW9NIn0.RJvshvzdstRBtmuzSzmLZw";

    var image = new Image();
    image.crossOrigin = '';

    image.onload = function() {
        cb(null, {tile: tile, image: image});
    };

    image.src= url;
};

var loadAllTiles = function(tiles, mapboxType, cb) {
    var imgs = [];

    for (var i in tiles) {
        var t = tiles[i];
        fetchTile(t, mapboxType, function(err, res) {
            imgs.push(res);
            if (imgs.length === tiles.length)
                cb(null, imgs);
        });
    }
};

var drawTilesToCanvas = function(ctx, bbox, tiles) {
    var rangex = bbox[2] - bbox[0];
    var rangey = bbox[3] - bbox[1];

    var scale = Math.max(rangex, rangey);

    var fx = 1024 / rangex;
    var fy = 1024 / rangey;

    for (var i in tiles) {
        var t = tiles[i];

        var tileWidth = t.tile.bbox[2] - t.tile.bbox[0];
        var tileHeight = t.tile.bbox[3] - t.tile.bbox[1];

        tileWidth *= fx;
        tileHeight *= fy;

        var tilex = - t.tile.offset[0] * fx;
        var tiley = t.tile.offset[1] * fy;

        var x = 512 + tilex - (tileWidth / 2);
        var y = 512 + tiley - (tileHeight / 2);

        ctx.drawImage(t.image, x, y, tileWidth, tileHeight);
        /*
        ctx.fillText(t.tile.x + ", " + t.tile.y, x + tileWidth / 2, y + tileHeight / 2);
        ctx.rect(x, y, tileWidth, tileHeight);
        ctx.stroke();
         */
    }
};


MapboxLoader.prototype.queryFor = function(bbox, imagerySource) {
    return {
        bbox: bbox.mins.slice(0, 2).concat(bbox.maxs.slice(0, 2)),
        imagerySource: imagerySource
    };
};

MapboxLoader.load = function(params, cb) {
	if (false) {
		return setTimeout(function() {
			var c = document.createElement("canvas");
			c.width = 1024;
			c.height = 1024;

			return cb(null, { image: c, needFlip: false });
		});
    }

    var bbox = params.bbox;
    var mapboxType = params.imagerySource || "hobu.l8a69jch";
    var s = new SphericalMercator();

    var tiles = tilesForRegion(s, bbox);

    loadAllTiles(tiles, mapboxType, function(err, images) {
        var c = document.createElement("canvas");

        c.width = 1024;
        c.height = 1024;

        var ctx = c.getContext("2d");
        drawTilesToCanvas(ctx, bbox, images);


        /*
        c.style.position = "absolute";
        c.style.left = 0;
        c.style.top = 0;
        c.style.width = 256;
        c.style.height = 256;

        document.body.appendChild(c);
         */

        cb(null, {
            image: c,
            needFlip: false
        });
    });
};

module.exports = {
    KittyLoader: KittyLoader,
    MapboxLoader: MapboxLoader
};
