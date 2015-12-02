// base mode
// All modes need to inherit from this
//

export class BaseMode {
    constructor(name) {
        this.name = name;
        this.handlers = {};
    }

    hasHandler(event) {
        return !!this.handlers[event];
    }

    invokeHandler(event, params) {
        let handler = this.handlers[event];
        console.log ("-- --", event, "on", this.name, "handler?", handler ? "YES" : "NO", "params:", params)

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
}
