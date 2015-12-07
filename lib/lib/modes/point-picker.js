// point-picker.js
// Point picker mode
//

import { BaseMode } from "./base-mode";
import { randomId, pickPoint } from "../util";
import { LineOfSight } from "../features/line-of-sight";

export class PointPicker extends BaseMode {
    constructor(modeManager, baseElement, renderer) {
        super(modeManager, "PointPicker");

        // keep track of attachments for points
        //
        this.attachments = {};

        // Attach handlers
        //
        super.registerHandler("mouse-enter", ({event, entity}) => {
            if (entity && entity.entity && entity.entity[0]) {
                let id = entity.entity[0];
                renderer.updatePoint(id, null, "hover");
            }
        });

        super.registerHandler("mouse-leave", ({event, entity}) => {
            if (entity && entity.entity && entity.entity[0]) {
                let id = entity.entity[0];
                renderer.updatePoint(id, null, "normal");
            }
        });

        super.registerHandler("mouse-down", ({event, pos}) => {
            // only act on the left mouse button
            //
            if (event.button === 0) {
                let id = randomId("point");
                let location = pickPoint(renderer, pos);

                console.log("adding new point with id:", id, "and location:", location);
                if (location)
                    renderer.addPoint(id, location, "hover");
            }
        });

        super.registerHandler("dragging", ({event, entity, pos}) => {
            if (entity && entity.entity && entity.entity[0]) {
                let id = entity.entity[0];
                let location = pickPoint(renderer, pos);
                if (location)
                    renderer.updatePoint(id, location);
            }
        });

        super.registerHandler("context-menu-on-entity", ({entity}) => {
            // an entity was clicked on, return actions
            if (entity && entity.entity && entity.entity[0]) {
                let id = entity.entity[0];
                let clearLoS = () => {
                    let los = this.attachments[id];
                    if (los) {
                        delete this.attachments[id];
                        los.resetState();
                    }
                };

                let options = {
                    "delete": ["Delete", () => {
                        clearLoS();
                        renderer.removePoint(id);
                    }],
                    "los": ["LoS", () => {
                        // The user asked for a line of sight, lets go ahead and
                        // add it

                        // TODO: Use a user adjusted height and size paramter
                        let worldLocation = entity.entity[1];
                        let location = [worldLocation[0], worldLocation[1] + 2, worldLocation[2]];
                        let size = 512;

                        let los = this.attachments[id];
                        if (los) {
                            // just update the attachment
                            los.go(location, size);
                        }
                        else {
                            let newLOS = new LineOfSight(renderer);

                            console.log("Adding a LOS overlay at:", location);
                            newLOS.go(location, size);

                            this.attachments[id] = newLOS;
                        }
                    }]
                };

                if (this.attachments[id]) {
                    // this point has an attachment, allow users to remove them
                    options["remove-los"] = ["Remove LoS", () => {
                        let los = this.attachments[id];
                        delete this.attachments[id];

                        // remove it
                        los.resetState();
                    }];
                }

                return options;
            }
        });
    }

    isSameEntity(a, b) {
        // both points need to have the same ID
        return a.entity[0] === b.entity[0];
    }
}

