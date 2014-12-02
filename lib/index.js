// index.js
// Entry point for policies
//

module.exports = {
    // policy and loaders
    Greyhound: require('./lib/greyhound'),
    Debug: require('./lib/debug'),

    // cameras
    Cameras: {
        Orbital: require("./lib/cameras/orbital").Orbital
    }
};
