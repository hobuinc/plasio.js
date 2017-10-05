;; attribs.cljs
;; Attribute management
;;

(ns renderer.engine.attribs
  (:require [renderer.engine.util :as u]
            [renderer.util :as rutil]
            [renderer.engine.specs :as specs]
            [renderer.engine.shaders :as sh]
            [cljs-webgl.constants.webgl :as webgl]
            [cljs-webgl.constants.buffer-object :as buffer-object]
            [cljs-webgl.constants.texture-parameter-name :as tparams]
            [cljs-webgl.constants.texture-filter :as tfilter]
            [cljs-webgl.buffers :as buffers]
            [cljs-webgl.texture :as texture]
            [cljs-webgl.shaders :as shaders]))

(defn- gen-id []
  (rutil/random-id))

(def ^:private ^:dynamic *gl-context* nil) ; The attribs creation and deletion executes in context of this gl-context

(defmulti reify-attrib first)        ; The type of attribs to load is always the first argument
(defmulti rereify-attrib first)
(defmulti unreify-attrib first)

(defn- coerce-uniforms [uniforms]
  (when uniforms
    (into []
          (for [i (range (.-length uniforms))
                :let [uniform (aget uniforms i)]]
            [(keyword (aget uniform 0)) (aget uniform 1)]))))

(defmethod reify-attrib :point-buffer [[_ props]]
  (let [total-points (aget props "totalPoints")]
    {:key          (aget props "key")
     :point-stride (aget props "pointStride")
     :total-points total-points
     :attributes   (js->clj (aget props "attributes"))
     :uniforms     (coerce-uniforms (aget props "uniforms"))
     :source       {:data (aget props "data")}
     :gl-buffer    (when-not (zero? total-points)
                     (buffers/create-buffer *gl-context*
                                           (aget props "data")
                                           buffer-object/array-buffer
                                           buffer-object/static-draw))}))


(let [texture-cache (atom {})]
  (defmethod reify-attrib :image-overlay [[_ props]]
    (let [image (aget props "image")
          need-flip (aget props "needFlip")]
      (or (get @texture-cache image)
          (let [texture (texture/create-texture
                          *gl-context*
                          :image image
                          :pixel-store-modes {webgl/unpack-flip-y-webgl need-flip}
                          :parameters {tparams/texture-min-filter tfilter/linear
                                       tparams/texture-mag-filter tfilter/linear})]
            (swap! texture-cache assoc image texture)
            texture)))))

(defn- -range [mins maxs]
  ;; we don't really care about Y because it has mostly nothing to do with imagery
  (let [nx (aget mins 0) nz (aget mins 2)
        xx (aget maxs 0) xz (aget maxs 2)
        cx (+ nx (/ (- xx nx) 2))
        cy (+ nz (/ (- xz nz) 2))]
    [(- nx cx) (- nz cy) (- xx cx) (- xz cy)]))

(defn- translation-matrix [translate]
  (let [x (aget translate 0)
        y (aget translate 1)
        z (aget translate 2)]
      (js/Array
       1 0 0 0
       0 1 0 0
       0 0 1 0
       x y z 1)))

(declare setup-bbox)

(defmethod reify-attrib :transform [[_ transform]]
  ;; Note that this stuff is straight from JS land, so most things here are JS objects
  ;; Much apologies in advance
  (let [position (aget transform "position")
        mins     (aget transform "mins")
        maxs     (aget transform "maxs")
        normalized-space? (aget transform "normalize")
        model-matrix (translation-matrix position)
        uv-range     (-range mins maxs)]
    {:model-matrix model-matrix
     :offset       (aget transform "offset")
     :mins         mins
     :maxs         maxs
     :normalized-space? normalized-space?
     :source {:position position
              :mins mins
              :maxs maxs}
     :uv-range     uv-range
     :bbox-params  (setup-bbox position
                               mins
                               maxs)}))

(defmethod rereify-attrib :point-buffer [[_ buf]]
  (let [source (get-in buf [:source :data])
        needs-update? (when source (.-update source))]
    (if needs-update?
      (do
        (aset source "update" false)
        (update buf :gl-buffer
                (fn [b]
                  (.deleteBuffer *gl-context* b)
                  (buffers/create-buffer *gl-context*
                                         source
                                         buffer-object/array-buffer
                                         buffer-object/static-draw))))
      buf)))

(defmethod rereify-attrib :image-overlay [[_ image]]
  image)

(defmethod rereify-attrib :transform [[_ transform]]
  transform)

(defmethod unreify-attrib :point-buffer [[_ buffer]]
  (when buffer
    (.deleteBuffer *gl-context* (:gl-buffer buffer))))

(defmethod unreify-attrib :image-overlay [[_ image]]
  ;; textures are managed by the cache, we can't just delete anything here
  ;;
  )

(defmethod unreify-attrib :transform [[_ transform]]
  (when-let [b (get-in transform [:bbox-params :buffer])]
    (.deleteBuffer *gl-context* b)))

(defprotocol IAttribLoader
  (reify-attribs [this context attribs])
  (attribs-in [this id] [this id korks])
  (check-rereify-all [this context])
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

  (attribs-in [_ id korks]
    (when-let [res (get @state id)]
      (let [korks (if (sequential? korks) korks [korks])]
        (get-in res korks))))

  (check-rereify-all [this context]
    (binding [*gl-context* context]
      (swap! state
             (fn [s]
               (into {}
                     (for [[k v] s]
                       [k (u/map-vals #(rereify-attrib %) v)]))))))

  (unreify-attribs [_ context id]
    (binding [*gl-context* context]
      (when-let [res (get @state id)]
        (swap! state dissoc id)
        (doall (u/map-vals #(unreify-attrib %) res))))))

(defn create-attribs-loader []
  (AttribCache. (atom {})))


;; some methods which need more work
;;
(declare gen-point-buffer)

(defn- setup-bbox
  "setup what we need to render bounding boxes for a rendered volume"
  [pos mins maxs]
  ;; generate a list of points as we need them rendering lines
  (let [point-buffer (gen-point-buffer pos mins maxs)
        ;; create a web-gl buffer out of them
        gl-buffer (buffers/create-buffer *gl-context*
                                         point-buffer
                                         buffer-object/array-buffer
                                         buffer-object/static-draw)]
    {:buffer gl-buffer}))


(defn gen-point-buffer [pos mins maxs]
  (let [mins (mapv #(- %1 (aget pos %2)) mins (range))
        maxs (mapv #(- %1 (aget pos %2)) maxs (range))

        arr (js/Float32Array. (* 12 3 2))
        ;; A simple function which picks elements out of either mins or max depending whether
        ;; for the given index the bit is turned on or off
        coord (fn [index]
                (js/Array
                 (get (if (bit-test index 2) maxs mins) 0)
                 (get (if (bit-test index 1) maxs mins) 1)
                 (get (if (bit-test index 0) maxs mins) 2)))
        ;; pairs of lines that we need for rendering our bounding boxes
        ;; 0 -> 000 -> mins, 7 -> 111 -> maxs
        pairs [[0 1] [0 2] [0 4] [1 3] [1 5]
               [5 7] [5 4] [6 7] [6 4] [6 2]
               [3 2] [3 7]]]
    (doall
     (map (fn [[s e] i]
            (let [s (coord s)
                  e (coord e)
                  off (* i 6)]
              (.set arr s off)
              (.set arr e (+ off 3))))
          pairs (range)))
    arr))
