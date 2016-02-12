// tile-loaders.js
// A whole bunch of tile loaders
//

var SphericalMercator = require("sphericalmercator");
var LRU = require("lru-cache");
var async = require("async");

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

var TileLoader = function(formatURL, layout, quality) {
    this.url = formatURL;
    this.layout = layout || "tms";
    this.quality = (quality === undefined || quality === null ? 1 : quality);
};

var DEFAULT_TILE_SIZE = 256;

var qualitySettings = function(quality) {
    if (quality === 0) {
        return [15, 5];
    }
    else if (quality === 1) {
        return [18, 15];
    }

    return [21, 25];
};

var detailLevel = function(s, quality, bbox) {
    // convert spherical to lat long
    //
    var l = s.inverse(bbox.slice(0, 2)).concat(s.inverse(bbox.slice(2)));

    let [startZoom, maxImages] = qualitySettings(quality);

    // find a zoom factor for which we have a resonable number of times to fetch
    var z = startZoom;
    var range = null;
    while(z > 0) {
        range = s.xyz(l, z);
        var c = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);

        if (c < maxImages)
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

var tilesForRegion = function(s, quality, bbox) {
    // give a region, figure out all the tiles needed with their
    var v = detailLevel(s, quality, bbox);

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

var fetchTile = function(tile, formatURL, cb) {
    var url = formatURL
        .replace("{{x}}", tile.x.toString())
        .replace("{{y}}", tile.y.toString())
        .replace("{{z}}", tile.zoom.toString());

    var image = new Image();
    image.crossOrigin = '';

    image.onerror = function() {
        cb(new Error("Image tile failed to load"));
    };

    image.onload = function() {
        console.log("LOAD COMPLETE!");
        cb(null, {tile: tile, image: image});
    };

    image.src = url;
};

var loadAllTiles = function(tiles, formatURL, cb) {
    async.map(tiles, (t, cb) => fetchTile(t, formatURL, cb), (err, images) => {
        if (err) return cb(err);
        cb(null, images);
    });
};

var drawTilesToCanvas = function(ctx, bbox, tiles) {
    var rangex = bbox[2] - bbox[0];
    var rangey = bbox[3] - bbox[1];

    var scale = Math.max(rangex, rangey);

    var fx = DEFAULT_TILE_SIZE / rangex;
    var fy = DEFAULT_TILE_SIZE / rangey;

    for (var i in tiles) {
        var t = tiles[i];

        var tileWidth = t.tile.bbox[2] - t.tile.bbox[0];
        var tileHeight = t.tile.bbox[3] - t.tile.bbox[1];

        tileWidth *= fx;
        tileHeight *= fy;

        var tilex = - t.tile.offset[0] * fx;
        var tiley = t.tile.offset[1] * fy;

        var x = (DEFAULT_TILE_SIZE / 2) + tilex - (tileWidth / 2);
        var y = (DEFAULT_TILE_SIZE / 2) + tiley - (tileHeight / 2);

        ctx.drawImage(t.image, x, y, tileWidth, tileHeight);
        /*
        ctx.fillText(t.tile.x + ", " + t.tile.y, x + tileWidth / 2, y + tileHeight / 2);
        ctx.rect(x, y, tileWidth, tileHeight);
        ctx.stroke();
         */
    }
};


TileLoader.prototype.queryFor = function(params) {
    let fullBBox = params.fullPointCloudBBox;
    let bbox = params.pointCloudBBox;

    let midX = fullBBox.mins[0] + (fullBBox.maxs[0] - fullBBox.mins[0]) / 2;

    var east = bbox.mins[0],
        west = bbox.maxs[0];

    east = 2 * midX - east;
    west = 2 * midX - west;

    // we now need to swap eat and west, since east is now greater than west, we flipped them
    var t = east; east = west ; west = t;

    var box = [east, bbox.mins[2], west, bbox.maxs[2]];


    // need to flip the axis around X = midX plane.
    return {
        bbox: box,
        url: this.url,
        quality: this.quality,
        layout: this.layout
    };
};

var cache = new LRU(200); // keep upto 200 images in cache

function _cacheKey(bbox, url, quality, layout) {
    var s = bbox.map(e => e.toFixed(3)).join(":") +
        url + quality + layout;
    return s;
}

TileLoader.load = function(params, cb) {
    // TODO: At some point we need to stop making duplicate queries, while
    // a query is in progress, we need to wait for it to finish to avoid making duplicate
    // ones.
    //
    if (false) {
        var whitetile = null;
        return setTimeout(function() {
            if (whitetile === null) {
                var c = document.createElement("canvas");
                c.width = 256;
                c.height = 256;
                var ctx = c.getContext("2d");
                ctx.fillStyle = "white";
                ctx.fillRect(0, 0, 256, 256);

                whitetile = c;
            }

            return cb(null, { image: whitetile, needFlip: false });
        });
    }

    let bbox = params.bbox,
        url = params.url,
        quality = params.quality,
        layout = params.layout;

    // the url is a unique key for us here, although it still has the placeholders in it
    // we really don't care about those, based on our bbox, url, quality and layout we can generate
    // a unique key (they will eventually generate the same image URLs).
    var key = _cacheKey(bbox, url, quality, layout);

    // if we have a cache hit, don't make a round-trip
    //
    var image = cache.get(key);
    if (image) {
        return setTimeout(function() {
            cb(null, image);
        });
    }

    var s = new SphericalMercator();
    if (quality === null ||
        quality === undefined) quality = 1;

    var tiles = tilesForRegion(s, quality, bbox);

    loadAllTiles(tiles, url, function(err, images) {
        if (err)
            return cb(err);
        
        var c = document.createElement("canvas");

        c.width = DEFAULT_TILE_SIZE;
        c.height = DEFAULT_TILE_SIZE;

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

        var res = {
            image: c,
            needFlip: false
        };

        cache.set(key, res);
        cb(null, res);
    });
};

module.exports = {
    KittyLoader: KittyLoader,
    TileLoader: TileLoader
};
