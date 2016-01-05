// profile-policy
// A simple policy which loads a profile view into a renderer
//

import { Profiler } from "./features/profile";
import { randomId } from "./util";
import { TransformLoader } from "./transform-loaders";
import { BBox } from "greyhound.js";



let profileCache = {};

class ProfileBufferLoader {
    static get key() { return "profile-loader"; }
    static get provides() { return "point-buffer" }

    static load(params, cb) {
        // this is a proxy loader which loads the stuff which has already been loaded by the profiler
        //
        console.log("params:", params);
        let id = params.id;
        let data = profileCache[id];
        if (!data)
            return cb(new Error("No such profile loaded"));

        // we have the data make sure its laid out correctly on how the renderer expects it
        //
        let pointStride = (data.buffer.length / data.totalPoints) * 4;
        let attributes = [["position", 0, 3], ["color", 0, 3]]; // for now just send down position and color
        cb(null, {
            pointStride: pointStride,
            totalPoints: data.totalPoints,
            attributes: attributes,
            data: data.buffer,
            stats: {}
        });
    }
}

export class ProfileLoaderPolicy {
    constructor(mainRenderer, renderer, params) {
        // we don't need any loaders here because we're going to provide our own loaders
        // Make sure the renderer is made aware of those
        this.mainRenderer = mainRenderer;
        this.renderer = renderer;
        this.params = params;

        this.fullPointCloudBBox = params.fullPointCloudBBox;
        this.lastAddedBuffers = [];

        if (!this.fullPointCloudBBox) {
            throw new Error("Missing field fullPointCloudBBox in params.  This is needed for the profiler.");
        }

        renderer.addLoader(ProfileBufferLoader);
        renderer.addLoader(TransformLoader);
    }

    // set the current profile regions we want to show
    // Accepts a list of region objects where a region object is
    // an object with three fields:
    //  - start - A 3-tuple with the starting location of the segment (in world coordinates)
    //  - end - A 3-tuple with the ending location of the segment (again, in world coordinates)
    //  - width - The width of the region
    setProfileRegions(region) {
        // we first capture this buffer since we need know the bounds etc.
        //

        console.log(this.fullPointCloudBBox);
        var p = new Profiler(this.mainRenderer, [[region.start, region.end]], region.width, this.fullPointCloudBBox);
        p.extractProfile(true, (err, profiles) => {
            if (err) return console.warn("Failed to run profile on region:", region);

            this.lastAddedBuffers.forEach(b => {
                this.renderer.removePointBuffer(b); // delete the buffer from the renderer
                delete profileCache[b["profile-loader"].id]; // delete cache entry
            });

            let profile = profiles[0];

            // we have the profile, cache it in
            console.log("got profile:", profile);

            // make the buffer Id for this buffer
            let id = randomId("profile");
            let transformLoader = new TransformLoader();
            let thisBuffer = {
                "profile-loader": {id: id},
                "transform": transformLoader.queryFor({
                    worldBBox: new BBox(profile.mins, profile.maxs),
                    normalize: true
                })
            };

            profileCache[id] = profile;

            this.lastAddedBuffers = [thisBuffer];
            this.renderer.addPointBuffer(thisBuffer);
            console.log("Added buffer:", thisBuffer);
        });
    }


}
