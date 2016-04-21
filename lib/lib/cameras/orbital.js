// orbital.js
// Orbital camera Mode, provides a mode which manipulates the camera
//


import { BaseMode } from "../modes/base-mode";
import { pickPoint, isLinux, isWindows, isChrome } from "../util";

var ms = function() {
    return (new Date()).getTime();
};

var torad = function(a) {
    return Math.PI * a / 180.0;
};

var easef = function (t) { return t<0.5 ? 2*t*t : -1+(4-2*t)*t; };

export class OrbitalCamera extends BaseMode {
    constructor(elem, renderer, f, props) {
        super("OrbitalCamera");

        this.elem = elem;
        this.f = f;

        var propOrDefault = function (prop, def) {
            if (!props || !props[prop])
                return def;

            return props[prop];
        };

        this.renderer = renderer;   // renderer to query points from
        this.maxDistance = propOrDefault("maxDistance", 400);
        this.distance = propOrDefault("distance", this.maxDistance);
        this.target = propOrDefault("target", [0, 0, 0]);    // the intial target
        this.elevation = propOrDefault("elevation", 40);        // the elevation from Y plane
        this.azimuth = propOrDefault("azimuth", 0);         // the angle of rotation around Y axis

        this.minDistance = 1.0;

        this.animFrameId = null;
        this.headingAnimFrameId = null;

        this.nextUpdateOverrides = null;
        this.isWaitingUpdate = false;

        var o = this;

        setTimeout(function () {
            o._emitCameraProps(null, true);
        });


        // some handlers we need access to
        super.registerHandler("double-click", ({pos}) => {
            var p = pickPoint(renderer, pos);
            if (p) {
                this._transitionTargetTo(p);
            }
        });

        super.registerHandler("synthetic-click", ({pos}) => {
            var p = pickPoint(renderer, pos);
            if (p) {
                this.invokeHandler("synthetic-click-on-point", {
                    pos: pos,
                    pointPos: p
                });
            }
        });

        super.registerHandler("hint-data-range", ({rx, ry, rz}) => {
            var dist = Math.sqrt((rx / 2) * (rx / 2) + (ry / 2) * (ry / 2));

            this.distance = dist;
            this.target = [0, 0, 0];    // always right in the middle

            this.maxDistance = this.distance * 4;

            setTimeout(() => {
                this._emitCameraProps(null, true);
            }, 0);
        });


        let dragstate = {};
        super.registerHandler("mouse-down", ({event, pos}) => {
            // click and drag handler
            //
            let buttonId = event.which || event.button;

            // if we're moving the point, lets bypass regular camera stuff
            //
            dragstate.ispanning = (buttonId === 3);

            if (dragstate.ispanning) {
                dragstate.start_target = this.target;
                dragstate.start_pos = pickPoint(renderer, pos);

                // we need to figure the axis we'd be moving along
                let props = this._cameraProps();
                let eye = props[0];
                let target = props[1];

                let targetToEye = vec3.subtract([], eye, target);
                vec3.normalize(targetToEye, targetToEye); // normalized vector from target to eye

                let rightVec = vec3.cross([], [0, 1, 0], targetToEye); // vector to the right
                let dir = vec3.cross([], rightVec, [0, 1, 0]);         // vector towards the user projected


                dragstate.lr = rightVec;
                dragstate.fb = dir;

                dragstate.distance = this.distance;
            }
            else {
                dragstate.start_e = this.elevation;
                dragstate.start_a = this.azimuth;
            }

            dragstate.active = true;
            dragstate.x = pos[0];
            dragstate.y = pos[1];
            dragstate.wasMoved = false;
        });

        super.registerHandler("dragging", ({event, pos}) => {
            if (!dragstate.active) {
                throw new Error("Got dragging event when I am not dragging?");
            }

            dragstate.wasMoved = true;
            var dx = pos[0] - dragstate.x;
            var dy = pos[1] - dragstate.y;

            if (dragstate.ispanning) {
                // when panning, change the actual 3D position of the target
                //
                var nf = Math.max(0.01, this._att() * this._range() * 0.001);

                // figure out the displacement based on the two vectors
                var p = vec3.add([],
                    vec3.scale([], dragstate.lr, -dx * nf),
                    vec3.scale([], dragstate.fb, -dy * nf));

                vec3.add(p, p, dragstate.start_target);

                this._emitCameraProps({
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
                this_e = Math.max(1, Math.min(80, this_e));

                this._emitCameraProps({
                    elevation: this_e,
                    azimuth: this_a
                });

                // store them for final application when the mouseclick is released
                dragstate.last_e = this_e;
                dragstate.last_a = this_a;
            }
        });

        let normalizeAzimuth = (a) => {
            // normalize azimuth
            if (a > 180) a = a - 360;
            if (a < -180) a = a + 360;

            return a;
        }
        super.registerHandler("mouse-up", ({event, pos}) => {
            dragstate.active = false;

            if (dragstate.wasMoved) {
                if (dragstate.ispanning) {
                    this.target = dragstate.last_position;
                }
                else {
                    this.azimuth = normalizeAzimuth(dragstate.last_a);
                    this.elevation = dragstate.last_e;
                }

                this._emitCameraProps(null, true);
            }
        });

        super.registerHandler("mouse-wheel", ({event, pos}) => {
            var m = event.wheelDelta || (-120 * event.detail);
            var r = this._range() / 100;


            var amp = 1.0; // no amplification by default

            // not sure why but sensitivity on windows in chrome is pretty terrible
            if ((isLinux() || isWindows()) && isChrome()) {
                amp = 5.0;
            }

            this.distance -= (0.01 * amp * m * r * (this.distance / this.maxDistance));
            this.distance = Math.min(Math.max(this.minDistance, this.distance), this.maxDistance);

            if (this.animFrameId === null && this.headingAnimFrameId === null)
                this._emitCameraProps(null, true);
        });
    }

    serialize() {
        return {
            distance: this.distance,
            maxDistance: this.maxDistance,
            target: this.target,
            elevation: this.elevation,
            azimuth: this.azimuth
        };
    }

    deserialize(state) {
        state = state || {};

        var o = this;
        var s = function(prop) {
            return (state[prop] == null || state[prop] == undefined) ?
                o[prop] : state[prop];
        };

        this.distance = s('distance');
        this.maxDistance = s('maxDistance');
        this.target = s('target');
        this.elevation = s('elevation');
        this.azimuth = s('azimuth');

        // update next time we get a chance
        setTimeout(function() {
            o._emitCameraProps(null, true, true);
        });
    }

    _att() {
        // tells us based on what our max and min distances are, what attentuation factor applies
        // based on this.distance;

        // normalize f to 0 -> 9 range, so that +1 gets it to 10 and we can do a log on it and get a nice 0 -> 1 range
        var f = (this.distance - this.minDistance) / (this.maxDistance - this.minDistance);
        return f;
    }

    _range() {
        // tells us based on what our max and min distances are, what attentuation factor applies
        // based on this.distance;

        return this.maxDistance - this.minDistance;
    }

    _cameraProps(overrides) {
        // emits the camera properties to event handler, with optional overrides
        // if available
        var right = vec3.create();
        var qe = quat.create();
        var qa = quat.create();
        var qr = quat.create();

        var up = [0, 1, 0];
        var dir = [0, 0, 1];

        var loc = [0, 0, 0];
        var eye = [0, 0, 0];

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
        quat.setAxisAngle(qa, up, torad(azimuth + 180));

        quat.multiply(qr, qa, qe);

        loc[2] = distance;
        vec3.transformQuat(eye, loc, qr);

        // now translate the eye by where the target is
        return [vec3.add(eye, target, eye), target];
    }

    _emitCameraProps(overrides, isFinal, isApplyingState) {
        this.nextUpdateOverrides = overrides;
        if (!this.isWaitingUpdate) {
            this.isWaitingUpdate = true;
            var o = this;
            requestAnimationFrame(function() {
                var p = o._cameraProps(o.nextUpdateOverrides);
                o.isWaitingUpdate = false;
                o.f(p[0], p[1], isFinal, isApplyingState);
            });
        }
    }

    _transitionTargetTo(newTarget, delay) {
        // cancel any animations which may be going on right now
        if (this.animFrameId !== null) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }

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
                o._emitCameraProps(null, true);
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
    }

    setHeading(newHeading, delay) {
        if (this.headingAnimFrameId !== null) {
            cancelAnimationFrame(this.headingAnimFrameId);
            this.headingAnimFrameId = null;
        }

        delay = delay || 500;


        var st = this.azimuth;
        var et = newHeading;

        var stime = ms();

        var o = this;

        var af = function() {
            var ttime = ms();
            if (ttime >= stime + delay) {
                o.azimuth = newHeading;

                while (o.azimuth > 360) o.azimuth -= 360;
                while (o.azimuth < 0) o.azimuth += 360;

                o.headingAnimFrameId = null;

                // send properties of the newly set stuff
                o._emitCameraProps(null, true);
            } else {
                var ff = (ttime - stime) / delay;

                ff = easef(ff);

                var v = st + (et - st) * ff;

                o._emitCameraProps({azimuth: v});
                o.headingAnimFrameId = requestAnimationFrame(af);
            }
        };

        af();
    };

    transitionTo(x, y, z) {
        let newPos = [
            x || this.target[0],
            y || this.target[1],
            z || this.target[2]
        ];

        this._transitionTargetTo(newPos);
    };
}
