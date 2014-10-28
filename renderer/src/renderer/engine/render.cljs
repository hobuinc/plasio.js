(ns renderer.engine.render
  "State renderer"
  (:require [renderer.log :as l]
            [cljs-webgl.context :as context]
            [cljs-webgl.shaders :as shaders]
            [cljs-webgl.constants.capability :as capability]
            [cljs-webgl.constants.draw-mode :as draw-mode]
            [cljs-webgl.constants.data-type :as data-type]
            [cljs-webgl.constants.buffer-object :as buffer-object]
            [cljs-webgl.constants.shader :as shader]
            [cljs-webgl.buffers :as buffers]
            [cljs-webgl.typed-arrays :as ta]))

(def bytes-per-point 8) ; XYZRGBIC


(defn- to-rads [a]
  (* (/ a 180.0) js/Math.PI))

(defn- projection-matrix [gl cam width height]
  (let [m (.-proj gl)
        aspect (if (< width height) (/ height width) (/ width height))
        fov  (to-rads (or (:fov cam) 75))
        near (or (:near cam) 0.1)
        far  (or (:far cam) 100000.0)]
    (if (= (:type cam) "perspective")
      (js/mat4.perspective m fov aspect near far)
      (js/mat4.ortho m (/ width -2) (/ width 2) (/ height 2) (/ height -2) near far))))


(def up-vector (array 0 1 0))

(defn- mv-matrix [gl eye target]
  (let [m (.-mv gl)
        eye (apply array eye)
        target (apply array target)]
    (js/mat4.lookAt m eye target up-vector)))

(defn- mvp-matrix [gl mv proj]
  (let [m (.-mvp gl)]
    (js/mat4.multiply m mv proj)))

(defn get-gl-context [elem]
  (let [gl (context/get-context elem)]
    (set! (.-proj gl) (js/Array 16))
    (set! (.-mv gl) (js/Array 16))
    (set! (.-mvp gl) (js/Array 16))
    gl))

(defn create-buffer
  "Given a Float32Array point buffer, creates a buffer suitable for rendering, not that points should be in
  a fixed format: XYZRGBIC (all floats)"
  [gl points]
  (let [total-points (/ (.-length points) bytes-per-point)
        buffer (buffers/create-buffer gl
                                      points
                                      buffer-object/array-buffer
                                      buffer-object/static-draw)]
    (set! (.-totalPoints buffer) total-points)
    buffer))


(defn- coerce [v typ]
  (let [v (if (or (sequential? v)
                  (= (type v) js/Array)) v [v])]
    (cond
      (#{:mat4 :float :vec4 :vec3 :vec2 } typ)  (ta/float32 v)
      (#{:int :tex} typ)                        (ta/int32 v)
      :else (throw (js/Error. (str "Don't know how to coerce type: " typ))))))

(defn- uniform [mp nm typ value]
  (assoc mp nm {:name (name nm)
                :type typ
                :values (coerce value typ)}))

(def identity-matrix (js/mat4.identity (js/Array 16)))

(def ^:private uniform-map (-> {}
                               (uniform :projectionMatrix :mat4 identity-matrix)
                               (uniform :modelViewMatrix :mat4 identity-matrix)
                               (uniform :modelViewProjectionMatrix :mat4 identity-matrix)

                               (uniform :pointSize :float 1.0)
                               (uniform :intensityBlend :float 0.0)
                               (uniform :maxColorComponent :float 1.0)

                               (uniform :rgb_f :float 1.0)
                               (uniform :class_f :float 0.0)
                               (uniform :map_f :float 0.0)
                               (uniform :imap_f :float 0.0)

                               (uniform :intensity_f :float 0.0)
                               (uniform :height_f :float 0.0)
                               (uniform :iheight_f :float 0.0)

                               (uniform :xyzScale :vec3 [1 1 1])
                               (uniform :clampLower :float 0)
                               (uniform :clampHigher :float 1)

                               (uniform :colorClampLower :float 0)
                               (uniform :colorClampHigher :float 1)

                               (uniform :zrange :vec2 [0 1])
                               (uniform :offsets :vec3 [0 0 0])
                               (uniform :map :tex 0)
                               (uniform :klassRange :vec2 [0 1])
                               (uniform :do_plane_clipping :int 0)
                               (uniform :planes :vec4 (repeat 24 0))))

(defn- uniforms-with-override [opts]
  (vals (reduce (fn [m [k v]]
                  (update-in m [k]
                             (fn [old]
                               (assoc old :values (coerce v (:type old)))))) uniform-map opts)))

(defn- draw-buffer
  [gl buffer shader proj mv render-options width height]
  (let [attrib-loc (partial shaders/get-attrib-location gl shader)
        stride     (* 4 bytes-per-point)
        attrib     (fn [nm size offset]
                     {:buffer buffer :location (attrib-loc nm) :components-per-vertex size
                      :type   data-type/float :stride stride :offset offset})
        total-points (.-totalPoints buffer)
        viewport {:x 0 :y 800 :width 1000 :height -800}
        uniforms (uniforms-with-override (assoc render-options
                                                :projectionMatrix proj
                                                :modelViewMatrix  mv
                                                :modelViewProjectionMatrix (mvp-matrix gl mv proj)))]
    (buffers/draw!
      gl
      :shader shader
      :draw-mode draw-mode/points
      :viewport viewport
      :first 0
      :count total-points
      :capabilities {capability/depth-test true}
      :attributes [(attrib "position" 3 0)
                   (attrib "color" 3 12)
                   (attrib "intensity" 1 24)
                   (attrib "classification" 1 28)]
      :uniforms uniforms)))

(defn render-state
  "Render the state in its current form"
  [{:keys [source-state] :as state}]
  (let [gl (:gl state)
        width  (context/get-drawing-buffer-width gl)
        height (context/get-drawing-buffer-height gl)
        cam (first (filter :active (:cameras source-state)))
        vw (:view source-state)
        dp (:display source-state)
        eye (or (:eye vw) [0 0 0])
        tar (or (:target vw) [0 0 0])
        proj (projection-matrix gl cam width height)
        mv   (mv-matrix gl eye tar)
        ro (:render-options dp)]
    ; clear buffer
    (apply buffers/clear-color-buffer gl (concat (:clear-color dp) [1.0]))
    (buffers/clear-depth-buffer gl 1.0)

    ; draw all loaded buffers
    (doseq [buf (vals (:point-buffers state))]
      (when-let [gl-buffer (:gl-buffer buf)]
        (draw-buffer gl gl-buffer (:shader state) proj mv ro width height)))))

