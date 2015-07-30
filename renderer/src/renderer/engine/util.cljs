(ns renderer.engine.util
  "Utility functions for everyone"
  (:require [renderer.engine.shaders :as s]
            [cljs-webgl.constants.buffer-object :as buffer-object]
            [cljs-webgl.constants.texture-parameter-name :as tparams]
            [cljs-webgl.constants.texture-filter :as tfilter]
            [cljs-webgl.constants.blending-factor-dest :as bf]
            [cljs-webgl.constants.draw-mode :as draw-mode]
            [cljs-webgl.constants.capability :as capability]
            [cljs-webgl.constants.texture-target :as texture-target]
            [cljs-webgl.constants.data-type :as data-type]
            [cljs-webgl.constants.texture-target :as texture-target]
            [cljs-webgl.constants.texture-filter :as tf]
            [cljs-webgl.constants.texture-parameter-name :as tpn]
            [cljs-webgl.constants.texture-wrap-mode :as twm]
            [cljs-webgl.constants.webgl :as webgl]
            [cljs-webgl.typed-arrays :as ta]
            [cljs-webgl.texture :as texture]
            [cljs-webgl.shaders :as shaders]
            [cljs-webgl.buffers :as buffers]
            [cljsjs.gl-matrix]))


(defn mk-vector
  "Creates a vector depending on number of arguments provided"
  ([x y] (js/THREE.Vector2. x y))
  ([x y z] (js/THREE.Vector3. x y z))
  ([x y z w] (js/THREE.Vector4. x y z w)))

(defn set-vector
  "Updates the vector depending on the number of arguments provided"
  ([v [x y z]] (.set v x y z))
  ([v x y] (.set v x y))
  ([v x y z] (.set v x y z))
  ([v x y z w] (.set v x y z w)))

(defn mk-color
  ([col]
   (apply mk-color (take 3 col)))
  ([r g b]
   (js/THREE.Color. r g b)))

(defn tvstr [o]
  (str "(" (.-x o) ", " (.-y o) ", " (.-z o) ")"))

(defn safe-korks [a]
  (if (nil? a)
    []
    (if (sequential? a) a [a])))

(defn- join-ks [a b]
  (let [a (safe-korks a)
        b (safe-korks b)]
    (concat a b)))

(defn get-set
  "Gets and sets up the value for give js object"
  [obj korks f]
  (let [korks (safe-korks korks)
        ks1 (butlast korks)
        k   (-> korks last name)
        obj (reduce #(aget %1 (name %2)) obj ks1)
        nv  (if (ifn? f) (f (aget obj k)) f)]
    (aset obj k nv)))


(defn- map-vals
  "Map values for the given map using f"
  [f m]
  (into {} (for [[k v] m]
             [k (f [k v])])))

(defn release-line-buffer [gl buffer]
  (.deleteBuffer gl buffer))

(defn make-line-buffer [gl points]
  (println points)
  (let [buf (->> (apply concat points)
                 (apply array)
                 (js/Float32Array.))
        _ (js/console.log buf)
        gl-buffer (buffers/create-buffer gl
                                         buf
                                         buffer-object/array-buffer
                                         buffer-object/static-draw)]
    (set! (.-prims gl-buffer) (-> points count dec))
    gl-buffer))

(defn canvas-of-size [width height]
  (let [canvas (.createElement js/document "canvas")]
    (set! (.-width canvas) width)
    (set! (.-height canvas) height)
    [canvas (.getContext canvas "2d")]))

(let [line-handle-assets (atom nil)]
  (letfn [(create-line-handle-buffer [gl]
            (let [buffer (buffers/create-buffer gl
                                                (js/Float32Array.
                                                 (array -1 -1 0
                                                        -1  1 0
                                                        1 1 0
                                                        -1 -1 0
                                                        1  1 0
                                                        1 -1 0))
                                                buffer-object/array-buffer
                                                buffer-object/static-draw)]
              buffer))


          
          (create-line-handle-texture [gl]
            (let [[canvas ctx] (canvas-of-size 64 64)]
              (.beginPath ctx)
              (set! (.-fillStyle ctx) "blue")
              (set! (.-strokeStyle ctx) "white")
              (set! (.-lineWidth ctx) 4)
              (.arc ctx 32 32 26 0 (* 2 js/Math.PI) false)
              (.fill ctx)
              (.stroke ctx)
              (texture/create-texture gl
                                      :image canvas
                                      :generate-mipmaps? true
                                      :pixel-store-modes {webgl/unpack-flip-y-webgl true}
                                      :parameters {tparams/texture-min-filter tfilter/linear-mipmap-nearest
                                                   tparams/texture-mag-filter tfilter/linear})))]
    (defn- create-get-line-handle-assets [gl width height]
      ;; if we don't have line handle assets, or if we have them for a different
      ;; viewport then we recreate them
      (if (and @line-handle-assets
               (= (:width @line-handle-assets) width)
               (= (:height @line-handle-assets) height))
        @line-handle-assets
        ;; assets may as well be null here, but we want to reuse an resouces that were
        ;; previously allocated, e.g. going from one viewport to another, really only
        ;; the projection matrix changes
        ;;
        (let [assets @line-handle-assets
              texture (or (:texture assets)
                          (create-line-handle-texture gl))
              gl-buffer (or (:gl-buffer assets)
                            (create-line-handle-buffer gl))
              proj (js/mat4.ortho (or (:proj assets)
                                      (js/mat4.create))
                                  0 width height 0 -10 10)]
          (reset! line-handle-assets
                  {:texture texture
                   :gl-buffer gl-buffer
                   :proj proj}))))))

(defn draw-line-handle [gl pxs viewport-width viewport-height]
  (let [{:keys [proj gl-buffer texture]} (create-get-line-handle-assets gl viewport-width viewport-height)
        shader (s/create-get-line-handle-shader gl)
        position-loc (shaders/get-uniform-location gl shader "position")]
    (doseq [[x y z] pxs]
      (buffers/draw! gl
                     :shader shader
                     :draw-mode draw-mode/triangles
                     :viewport {:x 0 :y 0 :width viewport-width :height viewport-height}
                     :first 0
                     :count 6
                     :capabilities {capability/depth-test false}
                     :textures [{:texture texture :name "sprite"}]
                     :uniforms [{:name "loc" :type :vec2 :values (ta/float32 [x y])}
                                {:name "p" :type :mat4 :values proj}
                                {:name "size" :type :float :values (ta/float32 [10.0])}]
                     :attributes [{:location position-loc
                                   :components-per-vertex 3
                                   :type data-type/float
                                   :stride 12
                                   :buffer gl-buffer}]))))

(let [sprite-buffer (atom nil)
      proj-matrix (atom {:mat (js/mat4.create)
                         :w   0
                         :h   0})]
  (defn create-get-2d-sprite-assets [gl vw vh]
    {:gl-buffer (or @sprite-buffer
                    (let [buffer (buffers/create-buffer gl
                                                        (js/Float32Array.
                                                          (array -1 -1 0
                                                                 -1 1 0
                                                                 1 1 0
                                                                 -1 -1 0
                                                                 1 1 0
                                                                 1 -1 0))
                                                        buffer-object/array-buffer
                                                        buffer-object/static-draw)]
                      (reset! sprite-buffer buffer)))
     :proj      (if (and (= (:w @proj-matrix) vw)
                         (= (:h @proj-matrix) vh))
                  (:mat @proj-matrix)
                  (do
                    (swap! proj-matrix
                          (fn [{:keys [mat]}]
                            {:mat (js/mat4.ortho mat
                                                 0 vw vh 0 -10 10)
                             :w   vw
                             :h   vh}))
                    (:mat @proj-matrix)))}))


(defn draw-2d-sprite [gl texture x y width height viewport-width viewport-height]
  (let [{:keys [proj gl-buffer]} (create-get-2d-sprite-assets gl viewport-width viewport-height)
        shader (s/create-get-sprite-shader gl)
        position-loc (shaders/get-uniform-location gl shader "position")]
    (buffers/draw! gl
                   :shader shader
                   :draw-mode draw-mode/triangles
                   :viewport {:x 0 :y 0 :width viewport-width :height viewport-height}
                   :first 0
                   :count 6
                   :capabilities {capability/depth-test false}
                   :textures [{:texture texture :name "sprite"}]
                   :uniforms [{:name "loc" :type :vec2 :values (ta/float32 [x y])}
                              {:name "p" :type :mat4 :values proj}
                              {:name "size" :type :vec2 :values (ta/float32 [width height])}]
                   :attributes [{:location position-loc
                                 :components-per-vertex 3
                                 :type data-type/float
                                 :stride 12
                                 :buffer gl-buffer}])))

(def font-size 40)

(defn create-text-texture [gl text]
  (let [canvas (.createElement js/document "canvas")
        ctx (.getContext canvas "2d")
        font-spec (str font-size "px sans-serif")
        _ (set! (.-font ctx) font-spec)
        width (.-width (.measureText ctx text))
        height (* font-size 1.4)]
    (set! (.-width canvas) width)
    (set! (.-height canvas) height)
    (set! (.-font ctx) font-spec)

    (set! (.-textBaseline ctx) "middle")
    (set! (.-textAlign ctx) "center")

    (set! (.-fillStyle ctx) "white")
    (set! (.-strokeStyle ctx) "black")
    (.fillText ctx text (/ width 2) (/ height 2))
    ;(.strokeText ctx text (/ width 2) (/ height 2))

    ;; we now need to create a texture out of this
    {:texture (texture/create-texture gl
                                      :image canvas
                                      :generate-mipmaps? false
                                      :pixel-store-modes {webgl/unpack-flip-y-webgl false}
                                      :parameters {tparams/texture-min-filter tfilter/linear
                                                   tparams/texture-mag-filter tfilter/linear
                                                   tparams/texture-wrap-s     twm/clamp-to-edge
                                                   tparams/texture-wrap-t     twm/clamp-to-edge})
     :width   (/ width 2)
     :height  (/ height 2)}))

(declare destroy-texture)

(defn destroy-text-texture [gl {:keys [texture]}]
  (destroy-texture gl texture))

(defn create-texture [gl image]
  (texture/create-texture gl
                          :image image
                          :generate-mipmaps? true
                          :pixel-store-modes {webgl/unpack-flip-y-webgl true}
                          :parameters {tparams/texture-min-filter tfilter/linear-mipmap-nearest
                                       tparams/texture-mag-filter tfilter/linear}))

(defn destroy-texture [gl texture]
  (.deleteTexture gl texture))


(defn- create-point-texture [gl border fill]
  (let [[canvas ctx] (canvas-of-size 64 64)]
    (.beginPath ctx)
    (set! (.-fillStyle ctx) fill)
    (set! (.-strokeStyle ctx) border)
    (set! (.-lineWidth ctx) 4)
    (.arc ctx 32 32 26 0 (* 2 js/Math.PI) false)
    (.fill ctx)
    (.stroke ctx)
    (texture/create-texture gl
                            :image canvas
                            :generate-mipmaps? true
                            :pixel-store-modes {webgl/unpack-flip-y-webgl true}
                            :parameters {tparams/texture-min-filter tfilter/linear-mipmap-nearest
                                         tparams/texture-mag-filter tfilter/linear})))

(let [point-texture (atom nil)]
  (defn create-get-point-textures [gl]
    (or @point-texture
        (reset! point-texture {:normal (create-point-texture gl "white" "blue")
                               :hover  (create-point-texture gl "blue" "white")}))))

(defn- to-screen [x y z width height]
  [(* (/ (+ x 1) 2) width)
   (* (/ (- 1 y) 2) height)
   z])

(defn ->screen [point mat width height]
  (let [p (apply array point)
        _ (js/vec3.transformMat4 p p mat)]
    (when (< (aget p 2) 1.0)
      (to-screen (aget p 0) (aget p 1) (aget p 2) width height))))
