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
            [cljs-webgl.shaders :as shaders]

            [goog.object :as gobject])
  (:require-macros [renderer.macros :refer [object-for js-map-foreach]]))

(defn- gen-id []
  (rutil/random-id))

(def ^:private ^:dynamic *gl-context* nil) ; The attribs creation and deletion executes in context of this gl-context

(defmulti reify-attrib (fn [a b]
                         a))        ; The type of attribs to load is always the first argument
(defmulti rereify-attrib (fn [a b]
                           a))
(defmulti unreify-attrib (fn [a b]
                           a))

(defn- coerce-uniforms [uniforms]
  (when uniforms
    (into []
          (for [i (range (.-length uniforms))
                :let [uniform (aget uniforms i)]]
            [(keyword (aget uniform 0)) (aget uniform 1)]))))

(defmethod reify-attrib "point-buffer" [_ props]
  (let [res (gobject/clone props)]
    ;; change some settings on how they appear
    (doto res
      (gobject/set "uniforms" (gobject/get res "uniforms"))
      (gobject/set "source" (gobject/get res "data"))
      (gobject/set "glBuffer" (when-let [buf (gobject/getValueByKeys res "data" "buf")]
                                (buffers/create-buffer *gl-context*
                                                       buf
                                                       buffer-object/array-buffer
                                                       buffer-object/static-draw))))))


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
    (js/Float32Array.
      (js/Array
        1 0 0 0
        0 1 0 0
        0 0 1 0
        x y z 1))))

(declare setup-bbox-buffer)
(defmethod reify-attrib "transform" [_ transform]
  ;; Note that this stuff is straight from JS land, so most things here are JS objects
  ;; Much apologies in advance
  (let [position (aget transform "position")
        mins (aget transform "mins")
        maxs (aget transform "maxs")
        normalized-space? (aget transform "normalize")
        model-matrix (translation-matrix position)
        uv-range (-range mins maxs)

        res (gobject/clone transform)]
    (doto res
      (gobject/set "modelMatrix" model-matrix)
      (gobject/set "uvRange" (into-array uv-range))
      (gobject/set "bboxBuffer" (setup-bbox-buffer position
                                                   mins
                                                   maxs)))))

(defmethod rereify-attrib "point-buffer" [_ buf]
  (let [source (gobject/get buf "source")
        needs-update? (when source (gobject/get source "update"))]
    (when needs-update?
      (gobject/set source "update" false)
      (.deleteBuffer *gl-context* (gobject/get buf "glBuffer"))
      (gobject/set buf "glBuffer"
                   (buffers/create-buffer *gl-context*
                                          (gobject/get source "buf")
                                          buffer-object/array-buffer
                                          buffer-object/static-draw)))))

(defmethod rereify-attrib "transform" [_ transform]
  )

(defmethod unreify-attrib "point-buffer" [_ buffer]
  (when buffer
    (.deleteBuffer *gl-context* (gobject/get buffer "glBuffer"))))

(defmethod unreify-attrib "transform" [_ transform]
  (when-let [b (gobject/get transform "bboxBuffer")]
    (.deleteBuffer *gl-context* b)))

(defprotocol IAttribLoader
  (reify-attribs [this context attribs])
  (attribs-in [this id])
  (check-rereify-all [this context])
  (unreify-attribs [this context id]))

(defrecord AttribCache [state]
  IAttribLoader
  (reify-attribs [_ context attribs]
    (binding [*gl-context* context]
      (let [loaded (gobject/map attribs
                                (fn [v k]
                                  (reify-attrib k v)))
            id     (gen-id)]
        (.set (-> @state :items) id loaded)
        id)))

  (attribs-in [_ id]
    (let [val (.get (-> @state :items) id)]
      val))

  (check-rereify-all [this context]
    (binding [*gl-context* context]
      (js-map-foreach (-> @state :items)
                      id resources
                      (object-for resources
                                  id2 params2
                                  (rereify-attrib id2 params2)))

      #_(swap! state
             (fn [s]
               (u/map-vals
                 (fn [[_ v]]
                   (u/map-vals #(rereify-attrib %) v))
                 s)))))

  (unreify-attribs [_ context id]
    (binding [*gl-context* context]
      (when-let [res (gobject/get (-> @state :items) id)]
        (.delete (-> @state :items) id)
        (object-for res k v
                    (unreify-attrib k v))))))

(defn create-attribs-loader []
  (AttribCache. (atom {:items (js/Map.)})))

;; some methods which need more work
;;
(declare gen-point-buffer)

(defn- setup-bbox-buffer
  "setup what we need to render bounding boxes for a rendered volume"
  [pos mins maxs]
  ;; generate a list of points as we need them rendering lines
  (let [point-buffer (gen-point-buffer pos mins maxs)
        ;; create a web-gl buffer out of them
        gl-buffer (buffers/create-buffer *gl-context*
                                         point-buffer
                                         buffer-object/array-buffer
                                         buffer-object/static-draw)]
    gl-buffer))


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
