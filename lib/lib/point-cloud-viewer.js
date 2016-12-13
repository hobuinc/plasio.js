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

import * as util from './util';

function checkParam(params, field, def) {
    const val = (params || {})[field];
    if (val === undefined || val === null) {
        if (def)
            return def;
        throw new Error('Invalid initialization: field is missing:' + field);
    }
    return val;
}

function normalizeScaleAndOffset(scale, offset) {
    let fixedScale, fixedOffset;
    if (scale == undefined || scale == null) {
        fixedScale = [1, 1, 1];
    } else if (scale.length && scale.length === 3) {
        fixedScale = [scale[0], scale[2], scale[1]];
    }
    else if (typeof(scale) === 'number') {
        fixedScale = [scale, scale, scale];
    }
    else throw new Error('Invalid scale specified:' + scale);

    if (offset == undefined || offset == null) {
        fixedOffset = [0, 0, 0];
    }
    else if (offset.length && offset.length === 3) {
        fixedOffset = [offset[0], offset[2], offset[1]];
    }
    else throw new Error('Invalid offset specified:' + offset);

    return [fixedScale, fixedOffset];
}



export class PointCloudViewer extends EventEmitter {
    constructor(targetElement, params) {
        if (!window.renderer) {
            throw new Error('Global object renderer is not available, make sure the correct renderer script is included.');
        }

        super();

        this.server = checkParam(params, 'server');
        this.resource = checkParam(params, 'resource');
        this.imagerySources = checkParam(params, 'imagerySources');

        this.rendererOptions = checkParam(params, 'rendererOptions', {});
        this.initialCameraParams = checkParam(params, 'initialCameraParams', {});

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

        this.renderer.setClearColor(this.rendererOptions.clearColor || [0.1, 0, 0]);
        this.renderer.setRenderOptions(this.rendererOptions);
    }

    start() {
        return fetch(this._baseUrl('info')) .then((response) => {
            if (!response.ok) {
                return Promise.reject(new Error('Failed to load config, server responded with: ' + response.status));
            }
            return response.json();
        }).then((config) => {
            // we have the resource configuration, go ahead and set things up
            this.emit('info', config);

            const [scale, offset] = normalizeScaleAndOffset(config.scale, config.offset);

            // get things out
            this.schema = config.schema;
            this.scale = scale;
            this.offset = offset;
            this.numPoints = config.numPoints;

            this.treeNativeBounds = config.bounds;
            this.geoBounds = [
                this.treeNativeBounds[0] * scale[0] + offset[0],
                this.treeNativeBounds[1] * scale[1] + offset[1],
                this.treeNativeBounds[2] * scale[2] + offset[2],
                this.treeNativeBounds[3] * scale[0] + offset[0],
                this.treeNativeBounds[4] * scale[1] + offset[1],
                this.treeNativeBounds[5] * scale[2] + offset[2]
            ];

            this.geoTransform = new GeoTransform(this.geoBounds, this.scale, this.offset);
            this.worldBounds = this.geoTransform.transform(config.bounds, 'tree', 'render');


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
            if (!_.isEmpty(this.initialCameraParams)) {
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
            return true;
        }).catch((e) => {
            this.emit('error', e);
        });
    }
}