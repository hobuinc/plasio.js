// base mode
// All modes need to inherit from this
//

export class BaseMode {
    constructor(name) {
        this.name = name;
        this.handlers = {};
    }

    invokeHandler(event, params) {
        let handler = this.handlers[event];
        console.log ("-- --", event, "on", this.name, "handler?", handler ? "YES" : "NO", "params:", params)

        if(handler) {
            handler.call(this, params);
        }
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
