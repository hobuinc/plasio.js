// orbital.js
// Orbital camera
//

var util = require("../util");

var ms = function() {
    return (new Date()).getTime();
};

var OrbitalCamera = function(elem, renderer, f, props) {
    this.elem = elem;
    this.f = f;

    var propOrDefault = function(prop, def) {
        if (!props || !props[prop])
            return def;

        return props[prop];
    };

    this.renderer = renderer;   // renderer to query points from
	this.maxDistance = propOrDefault("maxDistance", 400);
    this.distance = propOrDefault("distance", this.maxDistance);
    this.target = propOrDefault("target", [0, 0, 0]);    // the intial target
    this.elevation = propOrDefault("elevation", 40);        // the elevation from Y plane
    this.azimuth = propOrDefault("azimuth", 180);         // the angle of rotation around Y axis

    this.minDistance = 1.0;

    this._bindHandlers();

    this.animFrameId = null;
    this.nextUpdateOverrides = null;
    this.isWaitingUpdate = false;

    var o = this;

    setTimeout(function() {
        o._emitCameraProps();
    });
};

var torad = function(a) {
    return Math.PI * a / 180.0;
};

OrbitalCamera.prototype._att = function() {
	// tells us based on what our max and min distances are, what attentuation factor applies
	// based on this.distance;

	// normalize f to 0 -> 9 range, so that +1 gets it to 10 and we can do a log on it and get a nice 0 -> 1 range
	var f = (this.distance - this.minDistance) / (this.maxDistance - this.minDistance); 
	return f;
};

OrbitalCamera.prototype._range = function() {
	// tells us based on what our max and min distances are, what attentuation factor applies
	// based on this.distance;

	return this.maxDistance - this.minDistance;
};

OrbitalCamera.prototype.serialize = function() {
    return {
        distance: this.distance,
	    maxDistance: this.maxDistance,
        target: this.target,
        elevation: this.elevation,
        azimuth: this.azimuth
    };
};

OrbitalCamera.prototype.stop = function() {
    this._unbindHandlers();
};

OrbitalCamera.prototype.setHint = function(range) {
    // reset the camera properties and distance based on the range we
    // got here
    //
    var dist = Math.sqrt((range[0] / 2) * (range[0] / 2) +
                         (range[1] / 2) * (range[1] / 2));

    this.distance = dist;
    this.target = [0, 0, 0];    // always right in the middle

    this.maxDistance = this.distance;

    // unwound stack call
    var o = this;
    setTimeout(function() {
        o._emitCameraProps();
    });
};

OrbitalCamera.prototype._cameraProps = (function() {
    var right = vec3.create();
    var qe = quat.create();
    var qa = quat.create();
    var qr = quat.create();

    var up = [0, 1, 0];
    var dir = [0, 0, 1];

    var loc = [0, 0, 0];
    var eye = [0, 0, 0];
    
    return function(overrides) {
        // emits the camera properties to event handler, with optional overrides
        // if available

        overrides = overrides || {};

        var elevation = overrides.elevation || this.elevation;
        var azimuth = overrides.azimuth || this.azimuth;
        var distance = overrides.distance || this.distance;

        var target = overrides.target || this.target;

        // we need two rotations to figure out where the eye is going to be,
        // we first rotate around the Y axis using the azimuth
        //
        vec3.cross(right, dir, up);

        // figure out the quat rotations for the 
        quat.setAxisAngle(qe, right, torad(elevation));
        quat.setAxisAngle(qa, up, torad(azimuth));

        quat.multiply(qr, qa, qe);

        loc[2] = distance;
        vec3.transformQuat(eye, loc, qr);

        // now translate the eye by where the target is
        return [vec3.add(eye, target, eye), target];
    };
})();


OrbitalCamera.prototype._emitCameraProps = function(overrides) {
    this.nextUpdateOverrides = overrides;
    if (!this.isWaitingUpdate) {
        this.isWaitingUpdate = true;
        var o = this;
        requestAnimationFrame(function() {
            var p = o._cameraProps(o.nextUpdateOverrides);
            o.isWaitingUpdate = false;
            o.f(p[0], p[1]);
        });
    }
};

OrbitalCamera.prototype._transitionTargetTo = function(newTarget, delay) {
    // cancel any animations which may be going on right now
    if (this.animFrameId !== null) {
        cancelAnimationFrame(o.animFrameId);
        o.animFrameId = null;
    }

    var easef = function (t) { return t<0.5 ? 2*t*t : -1+(4-2*t)*t; };

    delay = delay || 500;
   
    var st = this.target;
    var et = newTarget;

    var stime = ms();

    var o = this;
    var af = function() {
        var ttime = ms();
        if (ttime >= stime + delay) {
            o.target = newTarget;
            o.animFrameId = null;

            // send properties of the newly set stuff
            o._emitCameraProps();
        } else {
            var ff = (ttime - stime) / delay;

            ff = easef(ff);

            var x = st[0] + (et[0] - st[0]) * ff;
            var y = st[1] + (et[1] - st[1]) * ff;
            var z = st[2] + (et[2] - st[2]) * ff;

            o._emitCameraProps({target: [x, y, z]});

            o.animFrameId = requestAnimationFrame(af);
        }
    };

    af();
};

var pointInSpace = function(o, evt) {
    var w = o.elem.offsetWidth,
        h = o.elem.offsetHeight;

	var x = evt.offsetX==undefined?evt.layerX:evt.offsetX;
	var y = evt.offsetY==undefined?evt.layerY:evt.offsetY;

    // pick a point in renderer
    //
    var p = o.renderer.pickPoint(x, y);

    console.log("Renderer returned:", p);

    return p;
};

OrbitalCamera.prototype._bindHandlers = function() {
    var o = this;

    // TODO: stop this stuff and do a eye position based on two
    // parameters a: angle along X axis and b: angle around Y axis
    // and compute the position of eye on the fly

    // double click handling
    //
    var ondblclick = function(evt) {
        o._transitionTargetTo(pointInSpace(o, evt));
    };

    var oncontextmenu = function(e) {
        e.preventDefault();
        return false;
    };

    
    // click and drag handler
    //
    var dragstate = {};
    var onmousedown = function(e) {
        e.preventDefault();

        var buttonId = e.which || e.button;

        dragstate.ispanning = (buttonId === 3);

        if (dragstate.ispanning) {
            dragstate.start_target = o.target;
            dragstate.start_pos = pointInSpace(o, e);

            // we need to figure the axis we'd be moving along
            var props = o._cameraProps();
            var eye = props[0];
            var target = props[1];

            var targetToEye = vec3.subtract([], eye, target);
            vec3.normalize(targetToEye, targetToEye); // normalized vector from target to eye

            var rightVec = vec3.cross([], [0, 1, 0], targetToEye); // vector to the right
            var dir = vec3.cross([], rightVec, [0, 1, 0]);         // vector towards the user projected



            dragstate.lr = rightVec;
            dragstate.fb = dir;

            dragstate.distance = o.distance;
        }
        else {
            dragstate.start_e = o.elevation;
            dragstate.start_a = o.azimuth;
        }

        dragstate.active = true;
        dragstate.x = e.clientX;
        dragstate.y = e.clientY;
        dragstate.wasMoved = false;

        // attach handlers to document so that we're notified when the mouse goes
        // out of the window
        var onmousemove = function(e) {
            e.preventDefault();

            if (!dragstate.active) return; // nothing to do here

            dragstate.wasMoved = true;
            var dx = e.clientX - dragstate.x;
            var dy = e.clientY - dragstate.y;


            if (dragstate.ispanning) {
                // when panning, change the actual 3D position of the target
                //
                var nf = Math.max(0.01, o._att() * o._range() * 0.001);

                // figure out the displacement based on the two vectors
                var p = vec3.add([],
                                 vec3.scale([], dragstate.lr, -dx * nf),
                                 vec3.scale([], dragstate.fb, -dy * nf));

                vec3.add(p, p, dragstate.start_target);
                
                //o._transitionTargetTo(p, 50);
                o._emitCameraProps({
                    target: p
                });

                dragstate.last_position = p;
            }
            else {
                var fac = 0.01;
                var ddx = (dx * fac) * (dx * fac) * (dx < 0 ? -1 : 1); 
                var ddy = (dy * fac) * (dy * fac) * (dy < 0 ? -1 : 1);
                
                var this_e = dragstate.start_e + ddy;
                var this_a = dragstate.start_a - ddx;

                // limit the elevation
                this_e = Math.max(10, Math.min(80, this_e));

                o._emitCameraProps({
                    elevation: this_e,
                    azimuth: this_a
                });

                // store them for final application when the mouseclick is released
                dragstate.last_e = this_e;
                dragstate.last_a = this_a;
            }
        };

        var norm = function(a) {
            // normalize azimuth
            if (a > 180) a = a - 360;
            if (a < -180) a = a + 360;

            return a;
        };

        var onmouseup = function(e) {
            e.preventDefault();
            
            dragstate.active = false;
            if (dragstate.wasMoved) {
                if (dragstate.ispanning) {
                    o.target = dragstate.last_position;
                }
                else {
                    o.azimuth = norm(dragstate.last_a);
                    o.elevation = dragstate.last_e;
                }

                o._emitCameraProps();
            }

            document.removeEventListener("mousemove", onmousemove);
            document.removeEventListener("mouseup", onmouseup);
        };

        document.addEventListener("mousemove", onmousemove);
        document.addEventListener("mouseup", onmouseup);
    };


    var isWindows = function() {
        return navigator.platform.indexOf("Win") === 0;
    };

    var isChrome = function() {
        var isChromium = window.chrome,
            vendorName = window.navigator.vendor;
        return (isChromium !== null && isChromium !== undefined && vendorName === "Google Inc.");
    };

    var onmousewheel = function(e) {
        e.preventDefault();
        var m = e.wheelDelta || (-120 * e.detail);
	    var r = o._range() / 100;

        var amp = 1.0; // no amplification by default

        // not sure why but sensitivity on windows in chrome is pretty terrible
        if (isWindows() && isChrome()) {
            amp = 5.0;
        }

        var d = 0.01 * amp * m * r * (o.distance / o.maxDistance);
        o.distance -= d;

        o.distance = Math.min(Math.max(o.minDistance, o.distance), o.maxDistance);

        if (o.animFrameId === null)
            o._emitCameraProps();
    };

    this.elem.addEventListener("dblclick", ondblclick);
    this.elem.addEventListener("contextmenu", oncontextmenu);
    this.elem.addEventListener("mousedown", onmousedown);
    this.elem.addEventListener("mousewheel", onmousewheel);
    this.elem.addEventListener("DOMMouseScroll", onmousewheel);

    var o = this;
    this._unbind = function() {
        o.elem.removeEventListener("dblclick", ondblclick);
        o.elem.removeEventListener("contextmenu", oncontextmenu);
        o.elem.removeEventListener("mousedown", onmousedown);
        o.elem.removeEventListener("mousewheel", onmousewheel);
        o.elem.removeEventListener("DOMMouseScroll", onmousewheel);
    };
};

OrbitalCamera.prototype._unbindHandlers = function() {
    if (this._unbind) {
        this._unbind();
        this._unbind = null;
    }
};


module.exports = {
    Orbital: OrbitalCamera
};
