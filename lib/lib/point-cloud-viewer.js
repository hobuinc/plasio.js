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
import {PointBufferCache} from "./point-buffer-cache";

function normalizeScaleAndOffset(fullGeoBounds, scale, offset) {
    let fixedScale, fixedOffset;
    // when no scale is specified, just specify a scale that we're ok with, using a scale < 1 helps us
    // encode things as integers which are faster in-flight
    //
    if (scale == undefined || scale == null) {
        //fixedScale = [0.01, 0.01, 0.01];
        fixedScale = [.01, .01, .01];
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
 * @callback cameraChangeCallbackFn
 * This handler hooks into the fine-grained camera events, for much finer event notification.
 * @param {Number[]} eyePosition The position of the eye.
 * @param {Number[]} targetPosition The position of the point the camera is looking at.
 * @param {Boolean} isFinal This value is <tt>false<tt> when the camera is transitioning, <tt>true</tt> when the camera
 * has finally settled at its final position.
 * @param {Boolean} isDeserializing This value is <tt>true</tt> when the camera properties changed because a saved state
 * is being applied, <tt>false</tt> if the camera change is due to a user action.
 */

/**
 * A simplified point cloud viewer which sets up the point cloud renderer using a set of paramters
 */
export class PointCloudViewer extends EventEmitter {
    /**
     * Setup a point cloud viewer on the given target element.
     * @param targetElement {HTMLDivElement} An element under which the renderer will be mounted.
     * @param params.server {String} The server address where the greyhound point cloud resource is located.
     * @param params.resource {String} The name of the greyhound resource.
     * @param params.brushes {[String]} An array of brush specs.
     * @param [params.allowGreyhoundCredentials] {Boolean} Whether to send a credentials flag.  Defaults to <tt>false</tt>.
     * @param [params.rendererOptions] {Object} An arbitrary object to setup initial renderer options.
     * @param [params.initialCameraParams] {Object} Serialized camera properties to setup the initial camera position.
     * @param [params.filter] {Object} Initial filter for querying entwine data.
     * @param [params.baseDepth] {Number} The base depth for the resource.  Defaults to 8.
     * @param [params.cameraChangeCallbackFn] {cameraChangeCallbackFn} A callback function to call when camera changes.  This is
     * different from a <tt>"view-changed"</tt> notification. This function is called for all camera changes (e.g. through animated
     * transitions etc.).
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
        this.brushes = util.checkParam(params, 'brushes');

        this.rendererOptions = Object.assign({}, util.checkParam(params, 'rendererOptions', {}));
        this.initialCameraParams = util.checkParam(params, 'initialCameraParams', null);
        this.filter = util.checkParam(params, 'filter', null);
        this.cameraChangeCallbackFn = util.checkParam(params, 'cameraChangeCallbackFn', null);
        this.allowGreyhoundCredentials = util.checkParam(params, 'allowGreyhoundCredentials', false);
        this.baseDepth = util.checkParam(params, 'baseDepth', 8);

        this.targetElement = targetElement;
        this.renderer = renderer.core.createRenderer(this.targetElement);

        this._setupRenderer();
    }

    _baseUrl(...parts) {
        return util.joinPath.apply(null,
            [util.pickOne(this.server), "resource", this.resource].concat(parts));
    }

    _setupRenderer() {
        let resizeHandler = () => {
            const rect = this.targetElement.getBoundingClientRect();
            this.renderer.setRenderViewSize(rect.width, rect.height);
        };

        window.addEventListener('resize', resizeHandler);
        resizeHandler();

        this.renderer.setClearColor(this.rendererOptions.clearColor || [0.1, 0.1, 0]);

        const options = Object.assign({}, this.rendererOptions);
        delete options.clearColor;

        this.renderer.setRenderOptions(options);
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
     * @returns {Promise.<Object>} The server configuration for the resource.
     */
    async start() {
        const response = await fetch(this._baseUrl('info'),
            this.allowGreyhoundCredentials ? { credentials: 'include'} : {}
        );

        if (!response.ok)
            throw Error('Failed to load resource config, server responded with:' + response.status);

        const config = await response.json();

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

        this.numPoints = config.numPoints;

        const stopSplitDepth = this.numPoints ? Math.ceil((Math.log(this.numPoints) / Math.log(4)) * 1.1) : 16;
        const hardStopDepth = Math.floor(stopSplitDepth * 1.5);

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
        console.log("... brushes:", this.brushes);
        console.log("... filter:", JSON.stringify(this.filter));
        console.log("... camera change callback:", (this.cameraChangeCallbackFn ? "YES" : "NO"));
        console.log("... allow credentials:", (this.allowGreyhoundCredentials ? "YES" : "NO"));
        console.log("... numPoints:", this.numPoints);
        console.log("... baseDepth:", this.baseDepth);
        console.log("... stopSplitDepth:", stopSplitDepth);
        console.log("... hardStopDepth:", hardStopDepth);
        console.log("mode parameters:");
        console.log("... initial camera options:", this.initialCameraParams);

        // construct things we need
        // A policy which brings point loader and transform provider together
        // so we can query and provide buffers to our renderer
        //
        const pipelineLoader = new GreyhoundPipelineLoader(this.server, this.resource, this.schema, {
            brushes: this.brushes,
            allowGreyhoundCredentials: this.allowGreyhoundCredentials,
            filter: this.filter
        });

        const policy = new FrustumLODNodePolicy("base", [
            pipelineLoader,
            new TransformLoader()
        ], this.renderer, {
            geoTransform: this.geoTransform,
            stopSplitDepth: stopSplitDepth,
            hardStopDepth: hardStopDepth,
            baseDepth: this.baseDepth
        });

        // Tell the point buffer cache what to call when it needs to ask for refresh requests.
        //
        PointBufferCache.getInstance().setRenderRequestFn(() => this.renderer.forceUpdate());

        // A mode manager which handles all the modes our input can be in
        //
        const modeManager = new ModeManager(
            this.targetElement, this.renderer,
            this.geoTransform,
            { pointCloudBBox: this.bbox },
            (eye, target, isFinal, isDeserializing) => {
                this.renderer.setEyeTargetPosition(eye, target)
                if (this.cameraChangeCallbackFn)
                    this.cameraChangeCallbackFn(eye, target, isFinal, isDeserializing);
            },
            this.initialCameraParams);

        this.policy = policy;
        this.pipelineLoader = pipelineLoader;
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
        this.renderer.updateCamera(0, {far: farPlane});

        this.policy.on('view-changed', () => {
            const state = modeManager.activeCamera.serialize();
            this.emit('view-changed', state);
        });

        // launch everything
        this.policy.start();
        return config;
    }


    /**
     * Get the renderer currently in use
     * @return {Object} The renderer instance.
     */
    getRenderer() {
        return this.renderer;
    }

    /**
     * Get the mode manager current in use.
     * @return {ModeManager|*}
     */
    getModeManager() {
        return this.modeManager
    }

    /**
     * Get the geo transform associated with the loaded resource.
     * @return {GeoTransform}
     */
    getGeoTransform() {
        return this.geoTransform;
    }

    /**
     * Set filter for querying entwine data
     *
     * @param filter {object} The entwine filer specification as a Javascript object.
     */
    setFilter(filter) {
        this.filter = filter;
        this.policy.hookedReload(() => this.pipelineLoader.setFilter(this.filter));
    }

    /**
     * Set the current set of channel brushes.  Upto 4 brushes may be specified.  The brush channels need to be specified
     * in order which correspond to the 4 color channels.  E.g. if the first brush needs to be unset, the brush spec at index 0
     * needs to be <tt>null</tt>.
     *
     * @param brushSpecs {String[]} An array of brush specs with no more than 4 elements.
     * @example
     * pointCloudViewer.setColorChannelBrushes([null, 'local://color']);
     */
    setColorChannelBrushes(brushSpecs) {
        if (brushSpecs.length > 4)
            throw new Error('Cannot specify more than 4 brush specs');

        this.policy.hookedReload(() => {
            this.brushes = brushSpecs;
            for (let i = 0 ; i < 4 ; i ++) {
                this.pipelineLoader.setColorChannelBrush(i, brushSpecs[i]);
            }
        });
    }
}