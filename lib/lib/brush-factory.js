/**
 * Created by verma on 12/30/16.
 */


import { BaseBrush } from './brush';


let availableBrushes = {};

/**
 * Creates brushes based on a URL spec, allows for registration and de-registration of brush types.  The library provides
 * several stock brushes which may be queried using {@link BrushFactory.availableBrushes} function.
 *
 * Custom brushes derived from the {@linkcode BaseBrush} class may be registered which then become available for use.  The
 * {@linkcode BrushFactory.registerBrush} may be used to do so.
 *
 *
 * ```javascript
 * class MapboxBrush extends BaseBrush {
 *     // ...
 * }
 *
 * // Makes the brush available as tms://mapbox?...
 * BrushFactory.registerBrush('tms', 'mapbox', MapboxBrush);
 * ```
 */
export class BrushFactory {
    /**
     * Creates a bursh given a brush spec in URL form.
     * @param {String} spec The brush specification, e.g. <tt>local://color</tt>.
     */
    static createBrush(spec) {
    }

    /**
     * Serialize given brushes to a JSON array.
     *
     * @param {BaseBrush[]} brushes An array of brushes to serialize.
     * @return {Object[]} An array of serialized brushes.
     */
    static serializeBrushes(brushes) {

    }

    /**
     * Deserialize given brushes from JSON and return instantiated {@link BaseBrush} instances.
     *
     * @param {Object[]} json An array of serialized brush objects.
     * @return {BaseBrush[]} An array of brush instances.
     */
    static deserializeBrushes(json) {
    }


    /**
     * Register a brush with the given scheme, name and implementation class. If a brush with the given
     * `scheme` and `name` are already registered, they are overriden by the provided implementation class `klass`.  This way
     * you can override stock brushes.
     *
     * @param {String} scheme The scheme name, e.g. <tt>local</tt>.
     * @param {String} name The unique name for the brush, e.g. <tt>color</tt>.
     * @param {Object} klass A class derived from the {@link BaseBrush} class.
     */
    static registerBrush(scheme, name, klass) {
    }


    /**
     * De-register an already registered brush.  No-op if there's no brush to de-register.
     * @param {String} scheme The scheme name of brush to de-register.
     * @param {String} name The unique name of the brush to de-register.
     */
    static deregisterBrush(scheme, name) {

    }

    /**
     * Get a list of available brushes.
     *
     * @return {String[]} An array of brushes available, e.g. <tt>["local://color"]</tt>.
     */
    static availableBrushes() {

    }
}
