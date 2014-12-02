// orbital.js
// Orbital camera
//

var ms = function() {
    return (new Date()).getTime();
};

var OrbitalCamera = function(elem, renderer, f) {
    this.elem = elem;
    this.f = f;

    this.renderer = renderer;   // renderer to query points from
    this.distance = 400;        // distance of eye from target
    this.target = [0, 0, 0];    // the intial target
    this.elevation = 40;        // the elevation from Y plane
    this.azimuth = -90;         // the angle of rotation around Y axis

    this._bindHandlers();

    this.animFrameId = null;

    var o = this;
    setTimeout(function() {
        o._emitCameraProps();
    });
};

var torad = function(a) {
    return Math.PI * a / 180.0;
};

OrbitalCamera.prototype.resetForHint = function(range) {
    // reset the camera properties and distance based on the range we
    // got here
    //
    var dist = Math.sqrt((range[0] / 2) * (range[0] / 2) +
                         (range[1] / 2) * (range[1] / 2));

    this.distance = dist;
    this.target = [0, 0, 0];    // always right in the middle

    // unwound stack call
    setTimeout(function() {
        this._emitCameraProps();
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
    var v = this._cameraProps(overrides);
    this.f(v[0], v[1]);
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

    // pick a point in renderer
    //
    var p = o.renderer.pickPoint(evt.offsetX, evt.offsetY);

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
    this.elem.addEventListener("dblclick", function(evt) {
        o._transitionTargetTo(pointInSpace(o, evt));
    });

    // make sure no right clicks
    this.elem.addEventListener("contextmenu", function(e) {
        e.preventDefault();
        return false;
    });

    // click and drag handler
    //
    var dragstate = {};
    this.elem.addEventListener("mousedown", function(e) {
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
                var nf = Math.min(Math.max(0.01, o.distance/1000), 1.0);

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
    });

    this.elem.addEventListener("mousewheel", function(e) {
        e.preventDefault();
        var d = 0.01 * e.wheelDelta;
        o.distance -= d;

        o.distance = Math.max(5, o.distance);


        if (o.animFrameId === null)
            o._emitCameraProps();
    });
};



module.exports = {
    Orbital: OrbitalCamera
};
