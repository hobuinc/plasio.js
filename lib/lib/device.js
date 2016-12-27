// device.js
// Device policies
//


/**
 * Device parameters abstraction.  This class is used to control aspects of the plasio pipeline based
 * on the device its running so we can provide the best experience on the device with limit power etc.
 */
export class Device {
    /**
     * Determines if we can run plasio.js on current device.
     * @return {boolean} true if the device supports running plasio.js, false otherwise.
     */
    static deviceSupportsPlasio() {
        // return true if device supports plasio
        if (!'Worker' in Window)
            return false

        return true ;
    }

    /**
     * Determines device capabilities and returns a set of system wide parameters to be used.
     */
    static caps() {
        return {
            loaderCount: 5,
            imageryCacheSize: 200,
            nodeRejectionRatio: 0.3
        }
    }
}

