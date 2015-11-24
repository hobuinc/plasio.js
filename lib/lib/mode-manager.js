// mode-manager.js
// Based on what the user is doing in the scene, this class manages
// which modes are active and which ones aren't.  Provides hooks which
// can then be called through user menus etc.
//

import { getxy, pickUIPoint } from "./util";
import { OrbitalCamera } from "./cameras/orbital";
import { PointPicker } from "./modes/point-picker";

export class ModeManager {
    constructor(element, renderer, viewChangedFn, defaultCameraParams) {
        this.e = element;
        this.r = renderer;

        this.currentMode = null; // what mode we're in right now?
        this.dragging = false;   // are we dragging?
        this.active = null;      // which mode was active when the dragging was initiated
        this.lastHoveredEntity = null; // needed to generate mouse-enter and mouse-leave events
        this.actionListeners = [];

        // Our camera, fallback for most actions
        this.camera = new OrbitalCamera(element, renderer,
            viewChangedFn, defaultCameraParams);

        // camera mode is the default current mode
        this.currentMode = this.camera;

        // All the entity modes we handle for now
        this.entityManagers = {
            "point": new PointPicker(element, renderer)
        };

        let entityToManager = entity => {
            if (entity)
                return this.entityManagers[entity.type];
        };

        this.mouseMoveHandler = e => {
            e.preventDefault();
            e.stopPropagation();

            let screenSpace = getxy(e);

            if (this.dragging) {
                // We are dragging so ignore all the default stuff and just update the
                // mode we're updating
                if (this.active) {
                    this.active.owner.invokeHandler("dragging", {
                        event: e,
                        entity: this.active.entity,
                        screenPos: screenSpace
                    });
                }
            }
            else {
                let entity = pickUIPoint(renderer, screenSpace);

                if (!this.isSameEntity(entity, this.lastHoveredEntity)) {
                    // the last hovered entity changed, do the eventing for mouse enter/leave
                    if (this.lastHoveredEntity) {
                        let manager = entityToManager(this.lastHoveredEntity);
                        if (manager) manager.invokeHandler("mouse-leave", {
                            event: e,
                            entity: this.lastHoveredEntity,
                            screenPos: screenSpace
                        });
                    }
                    // Invoke the handler on the next hovered entity
                    this.lastHoveredEntity = entity;
                    if (this.lastHoveredEntity) {
                        let manager = entityToManager(this.lastHoveredEntity);
                        if (manager) manager.invokeHandler("mouse-enter", {
                            event: e,
                            entity: this.lastHoveredEntity,
                            screenPos: screenSpace
                        });
                    }
                }
            }
        };

        this.mouseUpHandler = e => {
            // The mouse was released, just send down the event to our active entity
            if(this.active) {
                this.active.owner.invokeHandler("mouse-up", {
                    event: e,
                    entity: this.active.entity
                });

                this.active = null;
            }

            this.dragging = false;

            // remove handlers
            document.removeEventListener("mousemove", this.mouseMoveHandler);
            document.removeEventListener("mouseup", this.mouseUpHandler);
        };

        this.mouseDownHandler = e => {
            // if we clicked on an entity, we need to trigger the action on that
            // particular mode
            e.preventDefault();
            e.stopPropagation();

            let screenSpace = getxy(e);
            let entity = pickUIPoint(renderer, screenSpace);
            let entityManager = entityToManager(entity);

            // The mouse button could've come down on an entity, which means that the entity
            // would need to be notified that it was invoked because one of its components were
            // clicked on
            if (entityManager) {
                this.active = {
                    owner: entityManager,
                    entity: entity
                };

                // tell the owner that it was invoked because one of its entities were clicked on
                entityManager.invokeHandler("mouse-down-on-entity", {
                    event: e,
                    entity: entity,
                    screenPos: screenSpace
                });
            }
            else {
                // Nothing was clicked, so pass down the control to the current mode
                this.active = { owner: this.currentMode };
                this.currentMode.invokeHandler("mouse-down", {
                    event: e,
                    screenPos: screenSpace
                });
            }

            // we are dragging now
            this.dragging = true;

            // attach the handlers to the document so that scope is global
            document.addEventListener("mousemove", this.mouseMoveHandler, true);
            document.addEventListener("mouseup", this.mouseUpHandler, true);
        };

        let eventDispatcher = (eventName) => {
            return e => {
                e.preventDefault();
                e.stopPropagation();

                let screenSpace = getxy(e);
                let entity = pickUIPoint(renderer, screenSpace);
                let entityManager = entityToManager(entity);

                if (entityManager) {
                    entityManager.invokeHandler(eventName, {
                        event: e,
                        entity: entity,
                        screenPos: screenSpace
                    });
                }
                else {
                    this.currentMode.invokeHandler(eventName, {
                        event: e,
                        screenPos: screenSpace
                    });
                }
            }
        };

        this.doubleClickHandler = eventDispatcher("double-click");
        this.clickHandler = eventDispatcher("click");
        this.mouseWheelHandler = eventDispatcher("mouse-wheel");

        this.contextMenuHandler = e => {
            // the context menu handler works slightly differently, if there's a handler
            // available, the handler can return a list of actions to perform on the particular
            // context, these actions are passed down to the user of ModeManager for appropriate
            // display/action
            e.preventDefault();
            e.stopPropagation();

            let screenSpace = getxy(e);
            let entity = pickUIPoint(renderer, screenSpace);
            let entityManager = entityToManager(entity);

            let actions = null;
            if (entityManager) {
                actions = entityManager.invokeHandler("context-menu-on-entity", {
                    event: e,
                    entity: entity,
                    screenPos: screenSpace
                });
            }
            else {
                actions = this.currentMode.invokeHandler("context-menu", {
                    event: e,
                    screenPos: screenSpace
                });
            }

            if (actions && Object.keys(actions).length > 0 && this.actionListeners.length > 0) {
                // the context menu returned some actions, propagate these to the owner
                this.actionListeners.forEach(f => {
                    f.call(this, actions);
                });
            }
        };

        let e = element ? element : document;

        e.addEventListener("mousedown", this.mouseDownHandler);
        e.addEventListener("dblclick", this.doubleClickHandler);
        e.addEventListener("click", this.clickHandler);
        e.addEventListener("contextmenu", this.contextMenuHandler);
        e.addEventListener("mousewheel", this.mouseWheelHandler);
        e.addEventListener("DOMMouseScroll", this.mouseDownHandler);
    }

    get activeCamera() {
        return this.camera;
    }

    set activeMode(newMode) {
        // set the active mode for the mode manager, setting new mode as null is the
        // same as setting it to camera.
        if (!newMode || newMode === "camera") {
            this.currentMode = this.camera;
        }
        else {
            let mode = this.entityManagers[newMode];
            if (!mode)
                throw new Error("Don't recognize the mode you're trying to set: " + newMode);

            this.currentMode = mode;
        }
    }

    addActionListener(f) {
        this.actionListeners.push(f);
    }

    isSameEntity(a, b) {
        // rules for equivalence:
        // 1. Both entities are null
        // 2. Both entities have the same entity type and their manager says they are equivalent
        //

        // some shortpaths, two entityes
        if (a === null && b === null) {
            // both null
            return true;
        }
        else if ((a === null && b !== null) ||
            (b === null && a !== null)) {
            // one of them null
            return false;
        }
        else if (a.type === b.type) {
            // the types are the same, which means that we delegate the equivalence test to the manager
            let manager = this.entityManagers[a.type];
            if (!manager)
                return false; // no manager
            return manager.isSameEntity(a, b);
        }

        return false;
    }

    propagateDataRangeHint(rx, ry, rz) {
        // propagate to all our modes
        const hint = {
            rx: rx,
            ry: ry,
            rz: rz
        };

        const toInvoke = Object.values(this.entityManagers).concat([this.camera]);

        toInvoke.forEach(v => {
            v.invokeHandler("hint-data-range", hint);
        });
    }
}