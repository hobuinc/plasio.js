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

function normalizeScaleAndOffset(fullGeoBounds, { scale, offset}) {
    let fixedScale, fixedOffset;
    // when no scale is specified, just specify a scale that we're ok with, using a scale < 1 helps us
    // encode things as integers which are faster in-flight
    //
    if (!scale) {
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
    if (!offset) {
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
     * @param params {Object} Initialization parameters.
     * @param params.server {String} The server address where the greyhound point cloud resource is located.
     * @param params.resource {String|String[]} The name of the greyhound resource.  If passed in as a vector of strings,
     * each element specifies the <pre>resource@server</pre> pair formatted as such.  You may include the protocol as well. e.g.
     * <pre>test@https://www.myserver.com<pre>.  If no protocol is specified, http is assumed.   If no server part is specified
     * then the <pre>params.server<pre> is used as the resource's server.
     * @param params.brushes {String[]} An array of brush specs.
     * @param [params.allowGreyhoundCredentials] {Boolean} Whether to send a credentials flag.  Defaults to <tt>false</tt>.
     * @param [params.rendererOptions] {Object} An arbitrary object to setup initial renderer options.
     * @param [params.initialCameraParams] {Object} Serialized camera properties to setup the initial camera position.
     * @param [params.filter] {Object} Initial filter for querying entwine data.
     * @param [params.baseDepth] {Number} The base depth for the resource.  Defaults to 8.  This property is only applied to non-EPT resources.
     * @param [params.disableSplitLimiting] {Boolean} When specified, no split limiting is applied.  This property is only applied to non-EPT resources.
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

        this.server = util.checkParam(params, 'server', null);
        this.resource = util.checkParam(params, 'resource');

        // validate servers resources
        this.resource = util.parseResources(Array.isArray(this.resource) ? this.resource : [this.resource], this.server);
        this.brushes = util.checkParam(params, 'brushes');

        this.rendererOptions = Object.assign({}, util.checkParam(params, 'rendererOptions', {}));
        this.initialCameraParams = util.checkParam(params, 'initialCameraParams', null);
        this.filter = util.checkParam(params, 'filter', null);
        this.cameraChangeCallbackFn = util.checkParam(params, 'cameraChangeCallbackFn', null);
        this.allowGreyhoundCredentials = util.checkParam(params, 'allowGreyhoundCredentials', false);
        this.baseDepth = util.checkParam(params, 'baseDepth', 8);
        this.disableSplitLimiting = util.checkParam(params, 'disableSplitLimiting', false);

        this.targetElement = targetElement;
        this.renderer = renderer.core.createRenderer(this.targetElement);

        this._setupRenderer();
    }

    _baseUrl(server, resource, ...parts) {
        return util.joinPath.apply(null,
            [util.pickOne(server), "resource", resource].concat(parts));
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

    async _readResourceConfig(r) {
        // TODO, just directly reaching out to URL is not a good idea, we probably need a better resource reading
        // stuff here, e.g. a factory or something that yields objects for us which do the initial reading, for now
        // we'd have EPT and non-EPT resources
        const {server, resource, eptRootUrl} = r;
        const url = (eptRootUrl != null) ? util.joinPath(eptRootUrl, 'ept.json') :
            this._baseUrl(server, resource, 'info');

        const response = await fetch(url,
            this.allowGreyhoundCredentials ? {credentials: 'include'} : {}
        );

        if (!response.ok)
            throw Error('Failed to load resource config, server responded with:' + response.status);

        const config = await response.json();

        config.eptRootUrl = eptRootUrl;
        config.server = server;
        config.resource = resource;

        return config;
    }

    _parseScaleAndOffset(schema) {
        let offset = [0, 0, 0];
        let scale = [1, 1, 1];

        for (const s of schema) {
            if (s['name'] === 'X') {
                offset[0] = s['offset'] || 0;
                scale[0] = s['scale'];
            }
            else if (s['name'] === 'Y') {
                offset[1] = s['offset'] || 0;
                scale[1] = s['scale'];
            }
            else if (s['name'] === 'Z') {
                offset[2] = s['offset'] || 0;
                scale[2] = s['scale'];
            }
        }

        return {scale, offset};
    }

    /**
     * Start the point cloud viewer, this starts listening to UI events and starts pulling data from the greyhound
     * server.
     * @returns {Promise.<Object>} The server configuration for the resource.
     */
    async start() {
        const allConfigs = await Promise.all(this.resource.map(r => this._readResourceConfig(r)));
        console.log(allConfigs);

        // we have the resource configuration, go ahead and set things up
        this.emit('info', allConfigs);

        console.log("Startup parameters:");
        console.log("... brushes:", this.brushes);
        console.log("... filter:", JSON.stringify(this.filter));
        console.log("... camera change callback:", (this.cameraChangeCallbackFn ? "YES" : "NO"));
        console.log("... allow credentials:", (this.allowGreyhoundCredentials ? "YES" : "NO"));
        console.log("... split limiting:", (this.disableSplitLimiting ? "NO" : "YES"));
        console.log("mode parameters:");
        console.log("... initial camera options:", this.initialCameraParams);

        // Since a single mode manager is used across all resources, we need to give a transform
        // that spans across all resources, we also need it to determine where to render each tree
        const allBounds = util.joinBounds(allConfigs.map(c => c.boundsConforming));
        console.log('All configs bounds:', allBounds);
        const allOffset = util.boundsCenter(allBounds);

        console.log('All configs offset:', allOffset);
        const allBoundsGeoTransform = new GeoTransform(allBounds, [1, 1, 1], allOffset);

        // The geo transform exposed by this class is the cumulative geo transform of all resources.
        this.geoTransform = allBoundsGeoTransform;


        // initialize all config params
        this.configState = [];
        allConfigs.forEach(config => {
            const state = {};

            // is this resource EPT?
            const isEPT = (config['eptRootUrl'] != null);

            state.config = config;
            state.geoBounds = config.bounds;

            const [scale, offset] = normalizeScaleAndOffset(state.geoBounds,
                isEPT ? this._parseScaleAndOffset(config.schema) : {scale: config.scale, offset: config.offset}
            );

            // get things out
            state.schema = config.schema;
            state.scale = scale;
            state.offset = offset;
            state.numPoints = config.points;

            state.treeNativeBounds =
                state.geoBounds.map((v, i) => (v - offset[i % 3]) / scale[i % 3]);

            state.geoTransform = new GeoTransform(state.geoBounds, state.scale, state.offset);
            state.worldBounds = state.geoTransform.transform(state.geoBounds, 'geo', 'render');

            // EPT resources have no max, and the tree determines how far to go
            const stopSplitDepth =
                isEPT ? Number.MAX_SAFE_INTEGER :
                    (this.disableSplitLimiting ?
                        Number.MAX_SAFE_INTEGER :
                        (state.numPoints ? Math.ceil((Math.log(state.numPoints) / Math.log(4)) * 1.1) : 16));
            const hardStopDepth = Math.floor(stopSplitDepth * 1.5);

            const renderOffset = allBoundsGeoTransform.transform(state.offset, 'geo', 'render');

            // TODO: think really hard why I did this.
            renderOffset[0] = -renderOffset[0];
            renderOffset[1] = -renderOffset[1];
            renderOffset[2] = -renderOffset[2];

            const resourceBuffersKey = util.randomId("resource");

            // report what we got
            if (isEPT)
                console.log("resource parameters (EPT: " + config.eptRootUrl + "): ");
            else
                console.log("resource parameters (" + config.resource + "@" + config.server + "): ");

            console.log("... schema:", state.schema);
            console.log("... tree-native bounds:", state.treeNativeBounds);
            console.log("... world bounds:", state.worldBounds);
            console.log("... geo bounds:", state.geoBounds);
            console.log("... numPoints:", state.numPoints);
            console.log("... scale:", state.scale);
            console.log("... offset:", state.offset);
            console.log("... geo-transform:", state.geoTransform);
            console.log("... numPoints:", state.numPoints);
            console.log("... baseDepth:", state.baseDepth);
            console.log("... stopSplitDepth:", stopSplitDepth);
            console.log("... hardStopDepth:", hardStopDepth);
            console.log("... render space render offset:", renderOffset);
            console.log("... assigned key:", resourceBuffersKey);
            console.log("... EPT data storage:", config.dataType);

            // construct things we need
            // A policy which brings point loader and transform provider together
            // so we can query and provide buffers to our renderer
            //
            const {server, resource, eptRootUrl} = config;
            const pipelineLoader = new GreyhoundPipelineLoader({
                    server, resource, eptRootUrl
                },
                state.schema, {
                    brushes: this.brushes,
                    allowGreyhoundCredentials: this.allowGreyhoundCredentials,
                    filter: this.filter,
                    key: resourceBuffersKey,
                    eptDataStorage: config.dataType
                });

            const policy = new FrustumLODNodePolicy("base", [
                pipelineLoader,
                new TransformLoader({offset: renderOffset})
            ], this.renderer, {
                geoTransform: state.geoTransform,
                stopSplitDepth: stopSplitDepth,
                hardStopDepth: hardStopDepth,
                baseDepth: state.baseDepth,
                offset: renderOffset
            });

            state.pipelineLoader = pipelineLoader;
            state.policy = policy;
            state.key = resourceBuffersKey;
            state.visible = true;

            this.configState.push(state);
        });

        // Tell the point buffer cache what to call when it needs to ask for refresh requests.
        //
        PointBufferCache.getInstance().setRenderRequestFn(() => this.renderer.forceUpdate());

        // A mode manager which handles all the modes our input can be in

        console.log(allBoundsGeoTransform);
        const modeManager = new ModeManager(
            this.targetElement, this.renderer,
            allBoundsGeoTransform,
            {},
            (eye, target, isFinal, isDeserializing) => {
                this.renderer.setEyeTargetPosition(eye, target)
                if (this.cameraChangeCallbackFn)
                    this.cameraChangeCallbackFn(eye, target, isFinal, isDeserializing);
            },
            this.initialCameraParams);

        this.modeManager = modeManager;

        // determine view ranges in render transform
        const [dx, dy, dz] = allBoundsGeoTransform.coordinateSpaceRange('render');

        // setup initial camera hinting if no initial camera params are specified
        if (!this.initialCameraParams) {
            modeManager.propagateDataRangeHint(
                dx, dy, dz
            );
        }

        // set far plane
        const farPlane = Math.sqrt(dx * dx + dy * dy) * 2;
        this.renderer.updateCamera(0, {far: farPlane});

        const handleViewChanged = () => {
            const state = modeManager.activeCamera.serialize();
            this.emit('view-changed', state);
        };

        this.configState.forEach(c => {
            c.policy.on('view-changed', handleViewChanged);
            c.policy.start();
        });

        return allConfigs;
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

        this.configState.forEach(s => {
            s.policy.hookedReload(() => {
                s.pipelineLoader.setFilter(this.filter);
            })
        });
    }

    /**
     * Set the current set of channel brushes.  Up to 4 brushes may be specified.  The brush channels need to be specified
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

        this.brushes = brushSpecs;
        this.configState.forEach(s => {
            s.policy.hookedReload(() => {
                for (let i = 0; i < 4; i++) {
                    s.pipelineLoader.setColorChannelBrush(i, brushSpecs[i]);
                }
            });
        });
    }

    /**
     * Returns the set of all loaded resources
     *
     * @return {Object[]}  The configuration for each loaded resources.
     */
    getLoadedResources() {
        return this.configState;
    }

    /**
     * Sets the resource's visibility.
     * @param resourceId {String} The unique ID of the resource.
     * @param show {Boolean} Whether to hide or show the resource.  All resources are visible by default.
     */
    setResourceVisibility(resourceId, show) {
        this.renderer.setResourceVisibility(resourceId, show);
        for (let i = 0, il = this.configState.length ; i < il ; i++) {
            if (this.configState[i].key === resourceId) {
                this.configState[i].visible = show;
                break;
            }
        }
    }
}
