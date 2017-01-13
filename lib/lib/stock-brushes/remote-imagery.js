/**
 * @module stock-brushes/remote-imagery
 * Color by fetching tiles from a remote imagery service.  Supports OSM and TMS mapping.
 */

import { BaseBrush, NodeSelectionStrategy, ClampSelector } from '../brush';
import { TileLoader } from "../tile-loaders";
import { checkParam, maprange, equalBounds } from '../util';

/**
 * A remote imagery brush, fetches tiles from tile services and uses them for coloring points.
 */
export class RemoteImagery extends BaseBrush {
    /**
     * Construct a local field coloring brush.
     * @param {String} spec The complete spec used to instantiate this brush.
     * @param {String} scheme The schema name, should be <tt>remote</tt>.
     * @param {String} name The name for this brush, should be <tt>imagery</tt>.
     * @param {Object} params Parameters to construct this brush, these are passed as query parameters in spec.
     * @param {String} params.url The URL template to fetch images from.  This url should have placeholders for `x`, `y` and
     * `zoom` levels as `{{x}}`, `{{y}}`, `{{zoom}}` respectively.
     * @param {String} [params.scheme] The tile addressing scheme, should be either `tms` (Time Map Service) or
     * `osm` (OpenStreetMap/Google Maps).  Defaults to 'tms'.
     * @param {String} [params.quality] The tile quality, can be 0, 1, or 2.  Defaults to 0.
     */
    constructor(spec, scheme, name, params) {
        super(spec, scheme, name, params);

        this.url = checkParam(params, 'url');
        if (this.url.indexOf('{{x}}') == -1 ||
            this.url.indexOf('{{y}}') == -1 ||
            this.url.indexOf('{{z}}') == -1) {
            throw new Error('The url parameter needs to have placeholders for {{x}}, {{y}} and {{z}} variables.')
        }

        // When the user wants to do Z coloring , they actually want to read our Y coordinate.
        this.scheme = checkParam(params, 'scheme', 'tms');
        this.quality = parseInt(checkParam(params, 'quality', '0'));
    };

    serialize() {
        // All parameters are gotten from spec
        return {}
    }

    deserialize(json) {
        // Nothing to do here
    }

    async prepare(params, parentNode, childrenNodes) {
        const {
            geoTransform, renderSpaceBounds,
            treePath, lastStagedAttributes
        } = params;

        // When loading images, we need to know the geo bounds
        const geoBounds = geoTransform.transform(renderSpaceBounds, 'render', 'geo');
        const imageryBounds = [
            geoBounds[0], geoBounds[1],
            geoBounds[3], geoBounds[4]
        ];

        // if we have all our children loaded, then we don't need to fetch any imagery from the server
        // just assembling the child images should be sufficient
        // We know we have all the children if we have 8 child nodes, or if we have a single child node and
        // its bounds are the same as our bounds.
        if (lastStagedAttributes && lastStagedAttributes.image) {
            this.image = lastStagedAttributes.image;
        }
        else if (childrenNodes.length == 8 ||
            (childrenNodes.length == 1 && equalBounds(renderSpaceBounds, childrenNodes[0].renderSpaceBounds))) {
            this.image = TileLoader.emptyCanvas();
        }
        else {
            this.image = await TileLoader.loadImage(this.url, imageryBounds, this.quality, this.scheme);
        }

        const w = this.image.width,
              h = this.image.height;

        /*
        if (treePath == 'R') {
            document.body.appendChild(this.image);
            this.image.style.position = "fixed";
            this.image.style.right = 0;
            this.image.style.top = 0;
        }

        if (treePath == 'R1') {
            document.body.appendChild(this.image);
            this.image.style.position = "fixed";
            this.image.style.right = 0;
            this.image.style.top = 256;
        }

        if (treePath == 'R13') {
            document.body.appendChild(this.image);
            this.image.style.position = "fixed";
            this.image.style.right = 0;
            this.image.style.top = 512;
        }
        */

        // splat all child images
        this._splatChildImagery(this.image, renderSpaceBounds, childrenNodes);
        const imageData = this.image.getContext("2d").getImageData(0, 0, w, h).data;

        this.rf = function(x, z, color) {
            const bounds = renderSpaceBounds;
            const col = Math.floor(maprange(bounds[0], bounds[3], x, w, 0)),
                  row = Math.floor(maprange(bounds[2], bounds[5], z, h, 0));

            let offset = 4 * (row * w + col);
            color[0] = imageData[offset];
            color[1] = imageData[offset+1];
            color[2] = imageData[offset+2];
        };
    }

    stagingAttributes(params, parentNode, childrenNodes) {
        return {
            image: this.image,
            renderSpaceBounds: params.renderSpaceBounds.slice(0)
        };
    }

    nodeSelectionStrategy(params) {
        return { strategy: NodeSelectionStrategy.ANCESTORS };
    }

    bufferNeedsRecolor(params, strategyParams, testNodeStagedAttributes) {
        // A buffer always needs re-color if a child node is colored
        return true;
    }

    async unprepare(params) {
        delete this.image;
        delete this.rf;
    }

    colorPoint(color, point) {
        this.rf(point.x, point.z, color);
    }

    requiredSchemaFields() {
        return ['X', 'Y', 'Z'];
    }

    rampConfiguration() {
        return {
            selector: ClampSelector.NONE
        }
    }

    _splatChildImagery(destCanvas, renderSpaceBounds, childrenNodes) {
        const w = destCanvas.width,
              h = destCanvas.height;
        const ctx = destCanvas.getContext("2d");

        for (let i = 0, il = childrenNodes.length ; i < il ; i ++) {
            const rsb = childrenNodes[i].renderSpaceBounds;

            const x1 = Math.floor(maprange(renderSpaceBounds[0], renderSpaceBounds[3], rsb[0], 0, w));
            const y1 = Math.floor(maprange(renderSpaceBounds[2], renderSpaceBounds[5], rsb[2], 0, h));

            const x = (w/2) - x1,
                  y = (h/2) - y1;

            if (childrenNodes[i].image)
                ctx.drawImage(childrenNodes[i].image, x, y, (w/2), (h/2));
        }
    }
}
