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
            let id = entity.entity[0];
        });

        let lastPoint = null;
        let currentPoint = null;
        let currentLineId = null;

        this.registerHandler("mouse-down", ({event, pos}) => {
            // if the last point was added then this point will add a line
            // segment between the last point and this point,
            // and add another line for hover purposes
            if (event.button === 2) {
                // when the user clicks the right button, it means that we're done
                // adding a line
                if (currentPoint !== null) {
                    super.unlockMode();

                    renderer.removePoint(currentPoint);
                    currentPoint = lastPoint = currentLineId = null;
                }
            }
            else if (event.button === 0) {
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
    }
}
