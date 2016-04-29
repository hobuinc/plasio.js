// index.js
// Entry point for policies
//

import { FrustumLODNodePolicy, MultiPolicyContainer } from "./frustum-lod";
import { ProfileLoaderPolicy } from "./profile-policy";
import { GreyhoundPipelineLoader } from "./buffer-loaders";
import { MapboxLoader } from "./tile-loaders";
import { TransformLoader } from "./transform-loaders";
import { OrbitalCamera } from "./cameras/orbital";
import { ModeManager } from "./mode-manager";
import { PointPicker } from "./modes/point-picker";
import { Profiler } from "./features/profile";

module.exports = {
    // policy and loaders
    FrustumLODNodePolicy: FrustumLODNodePolicy,
    ProfileLoaderPolicy: ProfileLoaderPolicy,

    MultiPolicyContainer: MultiPolicyContainer,

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
        Profiler: Profiler
    }
};
