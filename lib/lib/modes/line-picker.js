// line-picker.js
// Line picker mode
//

var LinePicker = function(elem, renderer) {
    this.elem = elem;
    this.renderer = renderer;
    this.lastPickedPoint = null;
};

LinePicker.prototype.activate = function() {
    console.log("Activating line picker!");
    this._attachHandlers();
};

LinePicker.prototype.deactivate = function() {
    console.log("Deactivating line picker!");
    if (this._detachHandlers)
        this._detachHandlers();
};

LinePicker.prototype.resetState = function() {
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
    return p;
};

var randomId = function() {
    return Math.random().toFixed(20).substring(2);
};

function hslToRgb(h, s, l){
    var r, g, b;

    if(s == 0){
        r = g = b = l; // achromatic
    }else{
        var hue2rgb = function hue2rgb(p, q, t){
            if(t < 0) t += 1;
            if(t > 1) t -= 1;
            if(t < 1/6) return p + (q - p) * 6 * t;
            if(t < 1/2) return q;
            if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };

        var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        var p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }

    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
};

var randomColor = function() {
    return hslToRgb(Math.random(), 0.5, 0.6);
};

LinePicker.prototype._attachHandlers = function() {
    var o = this;
    
    var dblclick = function(e) {
        e.preventDefault();
        var p = pointInSpace(o, e);

        console.log("clicking on point:", p);

        // if we're
        if (o.lastPickedPoint) {
            var id = randomId(),
                color = randomColor();

            console.log("Adding line segment:", id, o.lastPickedPoint, p, color);

            o.renderer.addLineSegment(id, o.lastPickedPoint, p, color);
        }

        o.lastPickedPoint = p;
    };

    o.elem.addEventListener("dblclick", dblclick);

    this._detachHandlers = function() {
        o.elem.removeEventListener("dblclick", dblclick);
        o._detachHandlers = null;
    };
};

module.exports = {
    LinePicker: LinePicker
};
