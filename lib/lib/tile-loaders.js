// tile-loaders.js
// A whole bunch of tile loaders
//

const SphericalMercator = require("sphericalmercator");
const LRU = require("lru-cache");

import { Promise } from 'bluebird';
import { Device } from './device';
import * as util from './util';

// The default fetch size of a tile, this is pretty much a standard
//
const DEFAULT_TILE_SIZE = 256;

// Each pair represents the zoom level at which we start optimizing image downloads
// and the maximum number of images per region
const QUALITY_LEVELS = [
    [15, 5],
    [18, 15],
    [21, 25]
];

var cache = new LRU(Device.caps().imageryCacheSize); // keep upto 200 images in cache

/**
 * Loads imagery tiles for the specified source.
 */
export class TileLoader {
    /**
     * Construct a tile loader instance.
     * @param formatURL [String] The format url for the imagery source, needs placeholders for x, y and zoom as
     * {{x}}, {{y}} and {{z}}.
     * @param [layout] [String] The imagery layout, defaults to "tms".
     * @param [quality] [Number] The image quality 0, 1, or 2. 0 being lowest resolution and fewer network fetches.
     */
    constructor(formatURL, layout, quality) {
        this.url = formatURL;
        this.layout = layout || "tms";
        this.quality = quality || 1;

        if (!QUALITY_LEVELS[this.quality]) {
            throw new Error('Invalid quality setting: ' + quality);
        }
    }

    /**
     * Generate query params for the loading imagery for a specific region
     * @param params.geoTransform [GeoTransform] The geo transform for currently loading resource.
     * @param params.renderSpaceBounds [[Number]] A 6-element array for the render space bounds of the region to query.
     */
    queryFor(params) {
        const geoTransform = util.checkParam(params, 'geoTransform');
        const renderSpaceBounds = util.checkParam(params, 'renderSpaceBounds');

        const geoBounds = geoTransform.transform(renderSpaceBounds, 'render', 'geo');

        return {
            imageryBounds: [geoBounds[0], geoBounds[1], geoBounds[3], geoBounds[4]],
            url: this.url,
            quality: this.quality,
            layout: this.layout
        }
    }


    static _detailLevel(s, quality, bounds) {
        // convert spherical to lat long
        //
        const sw = bounds.slice(0, 2);
        const ne = bounds.slice(2);

        const l = s.inverse(sw).concat(s.inverse(ne));
        const [startZoom, maxImages] = quality;

        // find a zoom factor for which we have a resonable number of times to fetch
        let z = startZoom;
        let range = null;
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
    }

    static _forwardBBoxCenter(s, b) {
        const box = s.forward(b.slice(0, 2)).concat(s.forward(b.slice(2, 4)));
        return [[
            box[0] + (box[2] - box[0]) / 2,
            box[1] + (box[3] - box[1]) / 2
        ], box];
    }

    static _tilesForRegion(s, quality, bounds) {
        // give a region, figure out all the tiles needed with their
        const {zoom, range, region} = TileLoader._detailLevel(s, quality, bounds);
        const [regionCenter, regionBox] = TileLoader._forwardBBoxCenter(s, region);


        let tiles = [];
        for (let y = range.minY ; y <= range.maxY ; y ++) {
            for (let x = range.minX ; x <= range.maxX ; x++) {
                const b = s.bbox(x, y, zoom);
                const [center, tileBBox] = TileLoader._forwardBBoxCenter(s, b);
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
    }

    static async _fetchTile(tile, formatURL) {
        return new Promise((resolve, reject) => {
            const url = formatURL
                .replace("{{x}}", tile.x.toString())
                .replace("{{y}}", tile.y.toString())
                .replace("{{z}}", tile.zoom.toString());

            const image = new Image();
            image.crossOrigin = '';

            image.onerror = function () {
                reject(new Error("Image tile failed to load"));
            };

            image.onload = function () {
                resolve({
                    tile: tile, image: image
                });
            };

            image.src = url;
        });
    }

    static async _loadAllTiles(tiles, formatURL) {
        return await Promise.all(
            tiles.map(t => TileLoader._fetchTile(t, formatURL))
        );
    }

    static _drawTilesToCanvas(ctx, bbox, tiles) {
        const rangex = bbox[2] - bbox[0];
        const rangey = bbox[3] - bbox[1];

        const fx = DEFAULT_TILE_SIZE / rangex;
        const fy = DEFAULT_TILE_SIZE / rangey;

        for (let i = 0, il = tiles.length ; i < il ; i++) {
            const t = tiles[i];

            const tileWidth = (t.tile.bbox[2] - t.tile.bbox[0]) * fx;
            const tileHeight = (t.tile.bbox[3] - t.tile.bbox[1]) * fy;

            const tilex = - t.tile.offset[0] * fx;
            const tiley = t.tile.offset[1] * fy;


            const x = (DEFAULT_TILE_SIZE / 2) + tilex - (tileWidth / 2);
            const y = (DEFAULT_TILE_SIZE / 2) + tiley - (tileHeight / 2);

            ctx.drawImage(t.image, x, y, tileWidth, tileHeight);

            /*
             ctx.fillText(t.tile.x + ", " + t.tile.y, x + tileWidth / 2, y + tileHeight / 2);
             ctx.rect(x, y, tileWidth, tileHeight);
             ctx.stroke();
             */
        }
    }

    static _cacheKey(imageryBounds, url, quality, layout) {
        return imageryBounds.map(e => e.toFixed(3)).join(":") + url + quality + layout;
    }

    static async load(params) {
        const {
            imageryBounds, url,
            quality, layout
        } = params;

        // Check if we've already downloaded this image
        const key = TileLoader._cacheKey(imageryBounds, url, quality, layout);
        const image = cache.get(key);
        if (image)
            return image;

        // need to download and assemble stuff
        const qualityLevel = QUALITY_LEVELS[quality];

        const s = new SphericalMercator();
        const tiles = TileLoader._tilesForRegion(s, qualityLevel, imageryBounds);
        const images = await TileLoader._loadAllTiles(tiles, url);

        const c = document.createElement("canvas");
        c.width = DEFAULT_TILE_SIZE;
        c.height = DEFAULT_TILE_SIZE;

        const ctx = c.getContext("2d");

        TileLoader._drawTilesToCanvas(ctx, imageryBounds, images);

        const result = {
            image: c,
            needFlip: false
        };

        cache.set(key, result);
        return result;
    }
}


