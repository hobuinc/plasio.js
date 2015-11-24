// point-picker.js
// Point picker mode
//

import { BaseMode } from "./base-mode";
import { randomId, pickPoint } from "../util.js";

export class PointPicker extends BaseMode {
    constructor(baseElement, renderer) {
        super("PointPicker");

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

        super.registerHandler("mouse-down", ({event, screenPos}) => {
            let id = randomId("point");
            let location = pickPoint(renderer, screenPos);


            console.log("adding new point with id:", id , "and location:", location);
            if (location)
                renderer.addPoint(id, location, "hover");
        });

        super.registerHandler("dragging", ({event, entity, screenPos}) => {
            if (entity && entity.entity && entity.entity[0]) {
                let id = entity.entity[0];
                let location = pickPoint(renderer, screenPos);
                if (location)
                    renderer.updatePoint(id, location);
            }
        });

        super.registerHandler("context-menu-on-entity", ({entity}) => {
            // an entity was clicked on, return actions
            if (entity && entity.entity && entity.entity[0]) {
                let id = entity.entity[0];
                return {
                    "delete": ["Delete", () => {
                        renderer.removePoint(id);
                    }],
                    "los": ["Compute Line of Sight", () => {
                        console.log("going to do line of sight here!");
                    }]
                }
            }
        });
    }

    isSameEntity(a, b) {
        // both points need to have the same ID
        return a.entity[0] === b.entity[0];
    }
}

