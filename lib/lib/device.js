// device.js
// Device policies
//


/**
 * Device parameters abstraction.  This class is used to control aspects of the plasio pipeline based
 * on the device its running so we can provide the best experience on the device with limit power etc.
 */
export class Device {
    static __getCaps() {
        if (!Device.__caps) {
            // TODO: Detect device and set appropriate caps
            Device.__caps = {
                loaderCount: 5,
                imageryCacheSize: 200,
                nodeRejectionRatio: 0.35
            }
        }

        return Device.__caps;
    }
    /**
     * Determines if we can run plasio.js on current device.
     * @return {boolean} true if the device supports running plasio.js, false otherwise.
     */
    static deviceSupportsPlasio() {
        // return true if device supports plasio
        if (!'Worker' in Window)
            return false

        // TODO: A few more checks may be?

        return true ;
    }

    /**
     * Determines device capabilities and returns a set of system wide parameters to be used.
     */
    static caps() {
        return Device.__getCaps();
    }

    /**
     * Override a caps property, this means that you're going away from device recommendations and may result in
     * poor performance.
     * @param {String} propertyName  The name of the property, one of the properties returned from {@linkcode Device#caps} function.
     * @param value The value to override with.
     */
    static overrideProperty(propertyName, value) {
        const caps = Device.caps();
        caps[propertyName] = value;
    }
}

