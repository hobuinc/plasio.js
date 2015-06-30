var mat4 = require("gl-matrix").mat4;
var vec3 = require("gl-matrix").vec3;

var LineOfSight = function(renderer) {
    this.renderer = renderer;
}

LineOfSight.prototype.go = function(origin, radius) {
    console.log('Doing LOS');
}

module.exports = {
    LineOfSight: LineOfSight
};

