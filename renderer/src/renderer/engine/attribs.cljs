;; attribs.cljs
;; Attribute management
;;

(ns renderer.engine.attribs
  (:require [renderer.engine.util :as u]
            [renderer.engine.specs :as specs]
            [cljs-uuid.core :as uuid]
            [cljs-webgl.constants.buffer-object :as buffer-object]
            [cljs-webgl.constants.texture-parameter-name :as tparams]
            [cljs-webgl.constants.texture-filter :as tfilter]
            [cljs-webgl.buffers :as buffers]
            [cljs-webgl.texture :as texture]))


(defn- create-buffer
  "Given a Float32Array point buffer, creates a buffer suitable for rendering, note that points should be in
  a fixed format: XYZRGBIC (all floats)"
  [gl points]
  (let [total-points (/ (.-length points) specs/*bytes-per-point*)
        buffer (buffers/create-buffer gl
                                      points
                                      buffer-object/array-buffer
                                      buffer-object/static-draw)]
    (set! (.-totalPoints buffer) total-points)
    buffer))

(defn- gen-id []
  (-> (uuid/make-random)
      str))

(def ^:private ^:dynamic *gl-context* nil) ; The attribs creation and deletion executes in context of this gl-context

(defmulti reify-attrib first)        ; The type of attribs to load is always the first argument
(defmulti unreify-attrib first)

(defmethod reify-attrib :point-buffer [[_ buffer]]
  (create-buffer *gl-context* buffer))

(defmethod reify-attrib :image-overlay [[_ image]]
  (texture/create-texture *gl-context*
                          :image image
                          :parameters {tparams/texture-min-filter tfilter/linear
                                       tparams/texture-mag-filter tfilter/linear}))

(defn- max-range [mins maxs]
  ;; we don't really care about Z because it has mostly nothing to do with imagery, for now
  ;; get all the components out and return a tuple with our range of interest (wider one)
  (let [nx (aget mins 0) ny (aget mins 1)
        xx (aget maxs 0) xy (aget maxs 1)
        rx (- xx nx)    ry (- xy ny)]
    (if (> ry rx) [xy ny] [xx nx])))

(defn- transalation-matrix [translate]
  (let [x (aget translate 0)
        y (aget translate 1)
        z (aget translate 2)]
      (js/Array
       1 0 0 0
       0 1 0 0
       0 0 1 0
       x y z 1)))

(defmethod reify-attrib :transform [[_ transform]]
  ;; Note that this stuff is straight from JS land, so most things here are JS objects
  ;; Much apologies in advance
  (println (.. transform -position) (.. transform -mins) transform)
  (let [position (.. transform -position)
        position (js/Array (- (aget position 0)) (aget position 2) (aget position 1))
        mins     (.. transform -mins)
        maxs     (.. transform -maxs)
        model-matrix (transalation-matrix position)
        uv-range     (max-range mins maxs)]
    {:model-matrix model-matrix
     :offset       (aget transform "offset")
     :uv-range     uv-range}))

(defmethod unreify-attrib :point-buffer [[_ buffer]]
  (.deleteBuffer *gl-context* buffer))

(defmethod unreify-attrib :image-overlay [[_ image]]
  (.deleteTexture *gl-context* image))

(defmethod unreify-attrib :transform [[_ transform]]
  ;; nothing to do here
  )

(defprotocol IAttribLoader
  (reify-attribs [this context attribs])
  (attribs-in [this id] [this id korks])
  (unreify-attribs [this context id]))

(defrecord AttribCache [state]
  IAttribLoader
  (reify-attribs [_ context attribs]
    (binding [*gl-context* context]
      (let [loaded (u/map-vals #(reify-attrib %) attribs)
            id     (gen-id)]
        (swap! state assoc id loaded)
        id)))

  (attribs-in [this id]
    (attribs-in this id []))

  (attribs-in [this id korks]
    (when-let [res (get @state id)]
      (let [korks (if (sequential? korks) korks [korks])]
        (get-in res korks))))

  (unreify-attribs [_ context id]
    (binding [*gl-context* context]
      (when-let [res (get @state id)]
        (swap! dissoc state id)
        (doall (u/map-vals #(unreify-attrib %) res))))))

(defn create-attribs-loader []
  (AttribCache. (atom {})))
