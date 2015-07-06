// line-picker.js
// Line picker mode
//

var LinePicker = function(elem, renderer) {
    this.elem = elem;
    this.renderer = renderer;
    this.lastPickedPoint = null;
    this.currentLineId = null;
    this.lines = []; // all the points + which lines they affect
};

LinePicker.prototype.activate = function() {
    console.log("Activating line picker!");
    // always make sure things are detached before we start attaching
    if (this._detachHandlers) {
        this._detachHandlers();
    }
    this._attachHandlers();
};

LinePicker.prototype.deactivate = function() {
    console.log("Deactivating line picker!");
    this.lastPickedPoint = null;
    if (this._detachHandlers)
        this._detachHandlers();
};

LinePicker.prototype.resetState = function() {
    this.lastPickedPoint = null;
    for (var i = 0; i < this.lines.length; ++i) {
        this.renderer.removeLineSegment(this.lines[i][1]);
    }
    this.lines = [];
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
    return 'line-' + Math.random().toFixed(20).substring(2);
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
    return hslToRgb(Math.random(), 0.5, 0.7);
};

LinePicker.prototype._attachHandlers = function() {
    var o = this;

    var pick = function(e) {
        e.preventDefault();

        var p = pointInSpace(o, e);

	    var x = e.offsetX==undefined?e.layerX:e.offsetX;
	    var y = e.offsetY==undefined?e.layerY:e.offsetY;

        // get the screenspace point, take note of it
        //
        var sp = {x: x, y: y};

        if (!p) return;

        var id = randomId(),
            color = randomColor();

        o.currentLineId = id;
        o.currentLineColor = color;

        o.lastPickedPoint = p;

        o.lines.push([sp, id, o.lastPickedPoint, p, color]);
        o.renderer.addLineSegment(id, o.lastPickedPoint, p, color);
    };

    var mouseover = function(e) {
        e.preventDefault();

        if (o.currentLineId) {
            var p = pointInSpace(o, e);
            if (!p)
                return;

            // remove old and add new
            //
            o.renderer.updateLineSegment(o.currentLineId, null, p, null);

            /*
            o.renderer.removeLineSegment(o.currentLineId);
            o.currentLineId = randomId();

            o.renderer.addLineSegment(o.currentLineId, o.lastPickedPoint, p, o.currentLineColor);
             */
        }
    };

    o.elem.addEventListener("click", pick);
    o.elem.addEventListener("dblclick", pick);
    o.elem.addEventListener("mousemove", mouseover);

    this._detachHandlers = function() {
        o.elem.removeEventListener("click", pick);
        o.elem.removeEventListener("dblclick", pick);
        o.elem.removeEventListener("mousemove", mouseover);

        o._detachHandlers = null;

        // also remove last added line
        //
        if (o.currentLineId)
            o.renderer.removeLineSegment(o.currentLineId);

        o.currentLineId = o.lastPickedPoint = null;

    };
};

module.exports = {
    LinePicker: LinePicker
};
