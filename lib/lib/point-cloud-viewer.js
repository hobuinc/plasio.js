// point-cloud-viewer.js
// A simplified loader for point clouds from greyhound, without much hasstle

import 'whatwg-fetch';
import { EventEmitter } from 'events';
import * as _ from 'lodash'

import { FrustumLODNodePolicy } from './frustum-lod';
import { GreyhoundPipelineLoader } from './buffer-loaders';
import { TransformLoader } from './transform-loaders';
import { ModeManager } from "./mode-manager";
import { GeoTransform } from "./geotransform";
import { Device } from "./device";

import * as util from './util';

function normalizeScaleAndOffset(fullGeoBounds, scale, offset) {
    let fixedScale, fixedOffset;
    // when no scale is specified, just specify a scale that we're ok with, using a scale < 1 helps us
    // encode things as integers which are faster in-flight
    //
    if (scale == undefined || scale == null) {
        fixedScale = [0.01, 0.01, 0.01];
    } else if (scale.length && scale.length === 3) {
        fixedScale = scale;
    }
    else if (typeof(scale) === 'number') {
        fixedScale = [scale, scale, scale];
    }
    else throw new Error('Invalid scale specified:' + scale);

    // when no offset is specified, use the center of the bounds, our tree is always around the center
    // of the point cloud bounds
    //
    if (offset == undefined || offset == null) {
        fixedOffset = util.boundsCenter(fullGeoBounds);
    }
    else if (offset.length && offset.length === 3) {
        fixedOffset = offset;
    }
    else throw new Error('Invalid offset specified:' + offset);

    return [fixedScale, fixedOffset];
}


/**
 * A simplified point cloud viewer which sets up the point cloud renderer using a set of paramters
 */
export class PointCloudViewer extends EventEmitter {
    /**
     * Setup a point cloud viewer on the given target element.
     * @param targetElement [HTMLDivElement] An element under which the renderer will be mounted.
     * @param params.server [String] The server address where the greyhound point cloud resource is located.
     * @param params.resource [String] The name of the greyhound resource.
     * @param params.imagerySources[[String]] An array of imagery resources.
     * @param params.rendererOptions [Object] An arbitrary object to setup initial renderer options.
     * @param params.initialCameraParams [Object] Serialized camera properties to setup the intial camera position.
     */
    constructor(targetElement, params) {
        if (!PointCloudViewer.canRunPlasio()) {
            throw new Error('Current device is not capable of running Plasio.');
        }

        if (!window.renderer) {
            throw new Error('Global object renderer is not available, make sure the correct renderer script is included.');
        }

        super();

        this.server = util.checkParam(params, 'server');
        this.resource = util.checkParam(params, 'resource');
        this.imagerySources = util.checkParam(params, 'imagerySources');

        this.rendererOptions = util.checkParam(params, 'rendererOptions', {});
        this.initialCameraParams = util.checkParam(params, 'initialCameraParams', null);

        this.targetElement = targetElement;
        this.renderer = renderer.core.createRenderer(this.targetElement);
        this._setupRenderer();
    }

    _baseUrl(...parts) {
        return util.joinPath.apply(null, [this.server, "resource", this.resource].concat(parts));
    }

    _setupRenderer() {
        let resizeHandler = () => this.renderer.setRenderViewSize(window.innerWidth, window.innerHeight);
        window.addEventListener('resize', resizeHandler);
        resizeHandler();

        this.renderer.setClearColor(this.rendererOptions.clearColor || [0.5, 0, 0]);
        this.renderer.setRenderOptions(this.rendererOptions);
    }

    /**
     * Determines whether current device can run plasio
     * @return {Boolean} true if device can run plasio, false othewise.
     */
    static canRunPlasio() {
        return Device.deviceSupportsPlasio();
    }

    /**
     * Start the point cloud viewer, this starts listening to UI events and starts pulling data from the greyhound
     * server.
     */
    start() {
        return fetch(this._baseUrl('info')) .then((response) => {
            if (!response.ok) {
                return Promise.reject(new Error('Failed to load config, server responded with: ' + response.status));
            }
            return response.json();
        }).then((config) => {
            // we have the resource configuration, go ahead and set things up
            this.emit('info', config);

            this.geoBounds = config.bounds;
            const [scale, offset] = normalizeScaleAndOffset(this.geoBounds, config.scale, config.offset);

            // get things out
            this.schema = config.schema;
            this.scale = scale;
            this.offset = offset;
            this.numPoints = config.numPoints;

            this.treeNativeBounds =
                this.geoBounds.map((v, i) => (v - offset[i % 3]) / scale[i % 3]);

            this.geoTransform = new GeoTransform(this.geoBounds, this.scale, this.offset);
            this.worldBounds = this.geoTransform.transform(this.geoBounds, 'geo', 'render');


            // report what we got
            console.log("renderer parameters:");
            console.log("... options:", this.rendererOptions);
            console.log("resource paramters:");
            console.log("... schema:", this.schema);
            console.log("... tree-native bounds:", this.treeNativeBounds);
            console.log("... world bounds:", this.worldBounds);
            console.log("... geo bounds:", this.geoBounds);
            console.log("... numPoints:", this.numPoints);
            console.log("... scale:", this.scale);
            console.log("... offset:", this.offset);
            console.log("... geo-transform:", this.geoTransform);
            console.log("mode parameters:");
            console.log("... initial camera options:", this.initialCameraParams);

            // construct things we need
            // A policy which brings point loader and transform provider together
            // so we can query and provide buffers to our renderer
            //
            const policy = new FrustumLODNodePolicy("base", [
                new GreyhoundPipelineLoader(this.server, this.resource, this.schema, {
                    imagerySources: this.imagerySources,
                }),
                new TransformLoader()
            ], this.renderer, {
                geoTransform: this.geoTransform
            });

            // A mode manager which handles all the modes our input can be in
            //
            const modeManager = new ModeManager(
                this.targetElement, this.renderer,
                { pointCloudBBox: this.bbox },
                (eye, target) => this.renderer.setEyeTargetPosition(eye, target),
                this.initialCameraParams);

            this.policy = policy;
            this.modeManager = modeManager;

            // determine view ranges in render transform
            const [dx, dy, dz] = this.geoTransform.coordinateSpaceRange('render');

            // setup initial camera hinting if no initial camera params are specified
            if (!this.initialCameraParams) {
                modeManager.propagateDataRangeHint(
                    dx, dy, dz
                );
            }

            // set far plane
            const farPlane = Math.sqrt(dx * dx + dy * dy) * 2;
            this.renderer.updateCamera(0, {farPlane: farPlane});

            this.policy.on('view-changed', () => {
                const state = modeManager.activeCamera.serialize();
                this.emit('view-changed', state);
            });

            // launch everything
            this.policy.start();
        }).catch((e) => {
            this.emit('error', e);
        });
    }


    /**
     * Get the renderer currently in use
     * @return {Object} The renderer instance.
     */
    getRenderer() {
        return this.renderer;
    }
}