// line-picker.js
// Line picker mode
//

import { BaseMode } from "./base-mode";
import { randomId, pickPoint } from "../util";

export class LinePicker extends BaseMode {
    constructor(modeManager, baseElement, renderer) {
        super(modeManager, "LinePicker");

        this.registerHandler("mouse-enter", ({entity}) => {
            // we only get notified about the lines here
            //
            let id = entity.entity["line-id"];
            renderer.updateLineStripParams(id, {hover: true});
        });

        this.registerHandler("mouse-leave", ({entity}) => {
            let id = entity.entity["line-id"];
            renderer.updateLineStripParams(id, {hover: false});
        });

        let lastPoint = null;
        let currentPoint = null;
        let currentLineId = null;
        let haveOneSegment = false;

        this.registerHandler("mouse-down", ({event, pos}) => {
            // if the last point was added then this point will add a line
            // segment between the last point and this point,
            // and add another line for hover purposes
            if (event.button === 0) {
                let location = pickPoint(renderer, pos);

                // no further processing if no point picked
                if (!location)
                    return;

                if (lastPoint === null) {
                    // no last point, add two points and a line so that we can move around
                    let point1 = randomId("point");
                    let point2 = randomId("point");

                    renderer.addPoint(point1, location, "normal");
                    renderer.addPoint(point2, location, "hover");

                    lastPoint = point1;
                    currentPoint = point2;

                    let lineId = randomId("line");

                    renderer.createLineStrip(lineId, {});
                    renderer.pushLineStripPoint(lineId, point1);
                    renderer.pushLineStripPoint(lineId, point2);

                    currentLineId = lineId;
                    haveOneSegment = false;

                    console.log("No last point, adding points:", point1, point2);

                    super.lockMode();
                }
                else {
                    // we already had a last point that means that that the user is moving
                    // on and now wants to add another line
                    //
                    renderer.updatePoint(currentPoint, null, "normal");

                    lastPoint = currentPoint;
                    currentPoint = randomId("point");

                    renderer.addPoint(currentPoint, location, "hover");
                    renderer.pushLineStripPoint(currentLineId, currentPoint);

                    haveOneSegment = true;
                }
            }
        });

        // note that when the mouse click goes down we engage a lock in on our mode
        // indicating that we are not interested in regular stream of events, but rather
        // our mode locked events (simpler model).  That mode emits mouse move instead of
        // dragging/mouse-enter/mouse-leave events.
        //
        this.registerHandler("mouse-move", ({event, pos}) => {
            if (currentPoint !== null) {
                let location = pickPoint(renderer, pos);
                if (location) {
                    // we have an active point, update its position
                    // as we move our cursor around
                    //
                    renderer.updatePoint(currentPoint, location);
                }
            }
        });

        this.registerHandler("mouse-up", ({event, pos}) => {
            if (event.button === 2) {
                // when the user clicks the right button, it means that we're done
                // adding a line
                if (currentPoint !== null) {
                    super.unlockMode();

                    if (haveOneSegment) {
                        renderer.removePoint(currentPoint);
                        renderer.removeLineStripPoint(currentLineId, currentPoint);
                    }
                    else {
                        renderer.removePoint(currentPoint);
                        renderer.removePoint(lastPoint);

                        // since no segments were added to this strip, no point
                        // keeping it around
                        renderer.removeLineStrip(currentLineId);
                    }

                    currentPoint = lastPoint = currentLineId = null;
                }
            }
        });
    }

    isSameEntity(a, b) {
        return a.entity["line-id"] === b.entity["line-id"];
    }
}
