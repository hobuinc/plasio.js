// point-picker.js
// Point picker mode
//

var PointPicker = function(elem, renderer) {
    console.log('Point picker init');
    this.elem = elem;
    this.renderer = renderer;
    this.points = [];
};

PointPicker.prototype.activate = function() {
    console.log("Activating point picker!");
    this._attachHandlers();
};

PointPicker.prototype.deactivate = function() {
    console.log("Deactivating point picker!");
    if (this._detachHandlers)
        this._detachHandlers();
};

PointPicker.prototype.resetState = function() {
    for (var i = 0; i < this.points.length; ++i) {
        this.renderer.removeLineSegment(this.points[i]);
    }
    this.points = [];
};

var pointInSpace = function(o, evt) {
    var w = o.elem.offsetWidth,
        h = o.elem.offsetHeight;

	var x = evt.offsetX==undefined?evt.layerX:evt.offsetX;
	var y = evt.offsetY==undefined?evt.layerY:evt.offsetY;

    // pick a point in renderer
    //
    var p = o.renderer.pickPoint(x, y);

    if (Math.abs(p[0]) < 0.00001 &&
        Math.abs(p[1]) < 0.00001 &&
        Math.abs(p[2]) < 0.00001)
        return null;

    return p;
};

var randomId = function() {
    return 'point-' + Math.random().toFixed(20).substring(2);
};

PointPicker.prototype._attachHandlers = function() {
    var o = this;

    var pick = function(e) {
        e.preventDefault();

        var p = pointInSpace(o, e);
        console.log('Picked:', p);
        if (p) o._add(p, randomId());
    };

    o.elem.addEventListener("click", pick);
    o.elem.addEventListener("dblclick", pick);

    this._detachHandlers = function() {
        o.elem.removeEventListener("click", pick);
        o.elem.removeEventListener("dblclick", pick);
        o._detachHandlers = null;
    };
};

PointPicker.prototype._add = function(p, id) {
    this.points.push(id);
    this.renderer.addLineSegment(id, p, p, [255, 255, 255]);
}

module.exports = {
    PointPicker: PointPicker
};

