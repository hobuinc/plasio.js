// base mode
// All modes need to inherit from this
//

export class BaseMode {
    constructor(modeManager, name) {
        this.modeManager = modeManager;
        this.name = name;
        this.handlers = {};
    }

    hasHandler(event) {
        return !!this.handlers[event];
    }

    invokeHandler(event, params) {
        let handler = this.handlers[event];

        if(handler) {
            return handler.call(this, params);
        }

        return null;
    }

    isSameEntity(a, b) {
        console.warn("Unimplemented isSameEntity for", this.name, "going to return false");
        return false;
    }

    registerHandler(event, fn) {
        this.handlers[event] = fn;
    }

    unregisterHandler(event) {
        delete this.handlers[event];
    }

    lockMode() {
        this.modeManager.lockMode();
    }

    unlockMode() {
        this.modeManager.unlockMode();
    }
}
