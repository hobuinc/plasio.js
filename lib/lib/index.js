// index.js
// Entry point for policies
//

import { FrustumLODNodePolicy } from "./frustum-lod";
import { GreyhoundPipelineLoader } from "./buffer-loaders";
import { MapboxLoader } from "./tile-loaders";
import { TransformLoader } from "./transform-loaders";
import { OrbitalCamera } from "./cameras/orbital";
import { ModeManager } from "./mode-manager";
import { PointPicker } from "./modes/point-picker";

module.exports = {
    // policy and loaders
    FrustumLODNodePolicy: FrustumLODNodePolicy,

    // Loaders
    Loaders: {
        GreyhoundPipelineLoader: GreyhoundPipelineLoader,
        MapboxLoader: MapboxLoader,
        TransformLoader: TransformLoader
    },

    // cameras
    Cameras: {
        OrbitalCamera: OrbitalCamera
    },

    ModeManager: ModeManager,

    Modes: {
        PointPicker: PointPicker
    },

    Features: {
    }
};
