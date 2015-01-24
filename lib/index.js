// index.js
// Entry point for policies
//

module.exports = {
    // policy and loaders
    Greyhound: require('./lib/greyhound'),
    GreyhoundStatic: require('./lib/static-greyhound'),
    Debug: require('./lib/debug'),

    // cameras
    Cameras: {
        Orbital: require("./lib/cameras/orbital").Orbital
    },

    // Net
    P2PNode: require("./lib/p2p").P2PNode,
    Session: require("./lib/p2p").Session,
};
