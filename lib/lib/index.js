// index.js
// Entry point for policies
//

module.exports = {
    // policy and loaders
    Debug: require('./debug'),
    NodeDistancePolicy: require("./greyhound").NodeDistancePolicy,
    QuadTreeNodePolicy: require("./greyhound-lod").QuadTreeNodePolicy,

    // Loaders
    Loaders: {
        GreyhoundStaticLoader: require("./buffer-loaders").GreyhoundStaticLoader,
        GreyhoundPipelineLoader: require("./buffer-loaders").GreyhoundPipelineLoader,
        KittyLoader: require("./tile-loaders").KittyLoader,
        MapboxLoader: require("./tile-loaders").MapboxLoader,
        TransformLoader: require("./transform-loaders").TransformLoader
    },

    // cameras
    Cameras: {
        Orbital: require("./cameras/orbital").Orbital
    },

    // Net
    P2PNode: require("./p2p").P2PNode,
    Session: require("./p2p").Session
};
