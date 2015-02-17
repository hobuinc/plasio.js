(ns renderer.engine.render
  "State renderer"
  (:require [renderer.log :as l]
            [renderer.engine.shaders :as s]
            [renderer.engine.attribs :as attribs]
            [renderer.engine.specs :as specs]
            [cljs-webgl.context :as context]
            [cljs-webgl.shaders :as shaders]
            [cljs-webgl.constants.capability :as capability]
            [cljs-webgl.constants.blending-factor-dest :as bf]
            [cljs-webgl.constants.texture-target :as texture-target]
            [cljs-webgl.constants.data-type :as dt]
            [cljs-webgl.constants.framebuffer-object :as fbo]
            [cljs-webgl.constants.texture-filter :as tf]
            [cljs-webgl.constants.texture-parameter-name :as tpn]
            [cljs-webgl.constants.pixel-format :as pf]
            [cljs-webgl.constants.draw-mode :as draw-mode]
            [cljs-webgl.constants.data-type :as data-type]
            [cljs-webgl.constants.buffer-object :as buffer-object]
            [cljs-webgl.constants.shader :as shader]
            [cljs-webgl.buffers :as buffers]
            [cljs-webgl.typed-arrays :as ta]))



(defn- to-rads [a]
  (* (/ a 180.0) js/Math.PI))

(defn- projection-matrix [gl cam width height]
  (println "projection: " width height)
  (let [m (.-proj gl)
        aspect (if (< width height) (/ height width) (/ width height))
        fov  (to-rads (or (:fov cam) 75))
        near (or (:near cam) 0.1)
        far  (or (:far cam) 10000.0)]
    (println "aspect: " aspect)
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

(def ^:private uniform-map
  (-> {}
      (uniform :projectionMatrix :mat4 identity-matrix)
      (uniform :modelViewMatrix :mat4 identity-matrix)
      (uniform :modelViewProjectionMatrix :mat4 identity-matrix)
      (uniform :modelMatrix :mat4 identity-matrix)

      (uniform :pointSize :float 1.0)
      (uniform :intensityBlend :float 0.0)
      (uniform :maxColorComponent :float 1.0)

      (uniform :rgb_f :float 0.0)
      (uniform :class_f :float 0.0)
      (uniform :map_f :float 0.0)
      (uniform :imap_f :float 0.0)
      (uniform :overlay_f :float 1.0)

      (uniform :intensity_f :float 0.0)
      (uniform :height_f :float 0.0)
      (uniform :iheight_f :float 0.0)

      (uniform :xyzScale :vec3 [1 1 1])
      (uniform :clampLower :float 0)
      (uniform :clampHigher :float 1)

      (uniform :colorClampLower :float 0)
      (uniform :colorClampHigher :float 1)

      (uniform :zrange :vec2 [0 1])
      (uniform :uvrange :vec2 [0 1])
      (uniform :offset :vec3 [0 0 0])
      (uniform :map :tex 0)
      (uniform :klassRange :vec2 [0 1])
      (uniform :do_plane_clipping :int 0)
      (uniform :planes :vec4 (repeat 24 0))))

(def ^:private picker-uniform-map
  (-> {}
      (uniform :projectionMatrix :mat4 identity-matrix)
      (uniform :modelViewMatrix :mat4 identity-matrix)
      (uniform :modelViewProjectionMatrix :mat4 identity-matrix)
      (uniform :modelMatrix :mat4 identity-matrix)
      (uniform :pointSize :float 1.0)
      (uniform :xyzScale :vec3 [1 1 1])
      (uniform :zrange :vec2 [0 1])
      (uniform :offset :vec3 [0 0 0])
      (uniform :which :vec3 [0 0 0])))

(defn- uniforms-with-override [which-map opts]
  (reduce (fn [m [k v]]
            (update-in m [k]
                       (fn [old]
                         (if-let [typ (:type old)]
                           (assoc old :values (coerce v typ))
                           (throw (js/Error. (str "Don't know type for field: " k))))))) which-map opts))

(defn- draw-all-buffers
  [gl bufs shader base-uniform-map proj mv render-options width height]
  (let [attrib-loc (partial shaders/get-attrib-location gl shader)
        stride     (* 4 specs/*bytes-per-point*)
        attrib     (fn [nm size offset]
                     {:location (attrib-loc nm) :components-per-vertex size
                      :type   data-type/float :stride stride :offset offset})
        attribs    [(attrib "position" 3 0)
                    (attrib "color" 3 12)
                    (attrib "intensity" 1 24)
                    (attrib "classification" 1 28)]
        blend-func [bf/src-alpha bf/one-minus-src-alpha]
        viewport {:x 0
                  :y 0
                  :width width
                  :height height}
        uniforms (uniforms-with-override
                  base-uniform-map
                  (assoc render-options
                    :projectionMatrix proj
                    :modelViewMatrix  mv
                    :modelViewProjectionMatrix (mvp-matrix gl mv proj)))]
    ;; The only two loaders we know how to handle right now are:
    ;;      point-buffer - The actual point cloud
    ;;      image-overlay - The overlay for this point-buffer
    (doseq [{:keys [point-buffer image-overlay transform]} bufs]
      (let [total-points (.. point-buffer -totalPoints)
            buff-attribs (mapv #(assoc % :buffer point-buffer) attribs)
            textures (when image-overlay [{:texture image-overlay :name "overlay"}])
            uniforms (uniforms-with-override uniforms
                                             {:modelMatrix (:model-matrix transform) 
                                              :offset (:offset transform)
                                              :uvrange (:uv-range transform)})]
        (buffers/draw! gl
                       :shader shader
                       :draw-mode draw-mode/points
                       :viewport viewport
                       :first 0
                       :blend-func [blend-func]
                       :count total-points
                       :textures textures
                       :capabilities {capability/depth-test true}
                       :attributes buff-attribs
                       :uniforms (vals uniforms))))))

(defn- draw-buffer-for-picking
  [gl buffer shader base-uniform-map proj mv render-options width height]
  (let [{:keys [point-buffer transform]} buffer
        attrib-loc (partial shaders/get-attrib-location gl shader)
        stride     (* 4 specs/*bytes-per-point*)
        attrib     (fn [nm size offset]
                     {:buffer point-buffer
                      :location (attrib-loc nm)
                      :components-per-vertex size
                      :type   data-type/float :stride stride :offset offset})
        attribs    [(attrib "position" 3 0)]
        blend-func [bf/one bf/zero]
        viewport {:x 0
                  :y 0
                  :width width
                  :height height}
        total-points (.-totalPoints point-buffer)
        uniforms (uniforms-with-override
                  base-uniform-map
                  (assoc render-options
                    :offset (:offset transform)
                    :modelMatrix (:model-matrix transform)
                    :projectionMatrix proj
                    :modelViewMatrix  mv
                    :modelViewProjectionMatrix (mvp-matrix gl mv proj)))]
    (buffers/draw! gl
                   :shader shader
                   :draw-mode draw-mode/points
                   :first 0
                   :viewport viewport
                   :blend-func [blend-func]
                   :count total-points
                   :capabilities {capability/depth-test true}
                   :attributes attribs
                   :uniforms (vals uniforms))))


(defn- render-view-size [{:keys [gl]}]
  [(.-width (.-canvas gl)) (.-height (.-canvas gl))])

(defn render-state
  "Render the state in its current form"
  [{:keys [source-state] :as state}]
  (let [gl (:gl state)
        aloader (:attrib-loader state)
        [width height] (render-view-size state)
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
    (let [buffers-to-draw (->> state
                               :point-buffers
                               vals
                               (map :attribs-id)
                               (map #(attribs/attribs-in aloader %))
                               (remove #(or (nil? %) (nil? (:point-buffer %)))))]
      (draw-all-buffers gl buffers-to-draw
                        (:shader state)
                        uniform-map
                        proj mv ro width height))))


(defn- release-pick-buffers [gl bufs]
  ;; release all buffers for given bufs
  (doseq [b bufs]
    (.deleteFramebuffer gl (:fb b))
    (.deleteRenderbuffer gl (:db b))
    (.deleteTexture gl (:rt b))))

(defn- create-fb-buffer [gl width height]
  ;; create a frame buffer and set its size
  (let [fb (.createFramebuffer gl)
        rt (.createTexture gl)
        rb (.createRenderbuffer gl)]
    ;; bind framebuffer and set its size
    (.bindFramebuffer gl fbo/framebuffer fb)
    (set! (.-width fb) width)
    (set! (.-height fb) height)

    ;; bind texture and set its size, also have it initialize itself
    (.bindTexture gl texture-target/texture-2d rt)
    (.texParameteri gl texture-target/texture-2d tpn/texture-mag-filter tf/nearest) 
    (.texParameteri gl texture-target/texture-2d tpn/texture-min-filter tf/nearest)
    (.texImage2D gl
                 texture-target/texture-2d 0 pf/rgba
                 width height
                 0 pf/rgba dt/unsigned-byte nil)

    ;; bind render buffer
    (.bindRenderbuffer gl fbo/renderbuffer rb)
    (.renderbufferStorage gl
                          fbo/renderbuffer
                          fbo/depth-component16
                          width height)

    ;; set buffers for framebuffer
    (.framebufferTexture2D gl fbo/framebuffer fbo/color-attachment0 texture-target/texture-2d rt 0)
    (.framebufferRenderbuffer gl fbo/framebuffer fbo/depth-attachment fbo/renderbuffer rb)

    ;; All bindings done, unbind everything to restore state
    (.bindTexture gl texture-target/texture-2d nil)
    (.bindRenderbuffer gl fbo/renderbuffer nil)
    (.bindFramebuffer gl fbo/framebuffer nil)

    {:fb fb :rt rt :dp rb}))

(defn- create-pick-buffers
  "Create the 3 render buffers needed to pick points"
  [gl width height]
  {:x (create-fb-buffer gl width height)
   :y (create-fb-buffer gl width height)
   :z (create-fb-buffer gl width height)})


(defn- draw-picker [{:keys [source-state] :as state} shader target which]
  (let [gl (:gl state)
        aloader (:attrib-loader state)
        [width height] (render-view-size state)
        cam (first (filter :active (:cameras source-state)))
        vw (:view source-state)
        dp (:display source-state)
        eye (or (:eye vw) [0 0 0])
        tar (or (:target vw) [0 0 0])
        proj (projection-matrix gl cam width height)
        mv   (mv-matrix gl eye tar)
        ro (-> (:render-options dp)     ; picker rendering options don't need a ton of options
               (select-keys [:xyzScale :zrange :offset])
               (assoc :pointSize 20
                      :which which))]
    ;; render to the provided target framebuffer
    (.bindFramebuffer gl fbo/framebuffer (:fb target))

    (buffers/clear-color-buffer gl 0.0 0.0 0.0 0.0)
    (buffers/clear-depth-buffer gl 1.0)

    (doseq [{:keys [attribs-id]} (vals (:point-buffers state))]
      (when-let [buffer (attribs/attribs-in aloader attribs-id)]
        (draw-buffer-for-picking gl buffer shader
                                 picker-uniform-map
                                 proj mv ro width height)))

    ;; unbind framebuffer
    (.bindFramebuffer gl fbo/framebuffer nil)))

(defn- read-pixel [gl target x y]
  (let [buf (js/Uint8Array. 4)]
    (.bindFramebuffer gl fbo/framebuffer (:fb target))
    (.readPixels gl x y 1 1 pf/rgba dt/unsigned-byte buf)
    (.bindFramebuffer gl fbo/framebuffer nil)

    (let [as-float (js/Float32Array. (.-buffer buf))]
      (aget as-float 0))))

(defprotocol IPointPicker
  (pick-point [this state x y]))


(defrecord PointPicker [picker-state]
  IPointPicker
  (pick-point [this {:keys [source-state] :as state} client-x client-y]
    (let [gl (:gl state)
          [w h] (render-view-size state)]
      ;; if we haven't loaded the shader yet, do so now
      ;;
      (when-not (:shader @picker-state)
        (let [shader (s/create-picker-shader gl)]
          (swap! picker-state assoc :shader shader)))
      
      ;; first determine if the size of the display has changed on us
      ;;
      (when (or (not= w (:width @picker-state))
                (not= h (:height @picker-state)))
       ;; the size of the view changed on us, re-create the buffers
       (release-pick-buffers gl (select-keys @picker-state [:x :y :z]))
       (let [bufs (create-pick-buffers gl w h)]
         (swap! picker-state assoc
                :width w
                :height h
                :x (:x bufs)
                :y (:y bufs)
                :z (:z bufs))))
      ;; now go ahead and render the three buffers and read the point
      (let [shader (:shader @picker-state)]
        (draw-picker state shader (:x @picker-state) [1 0 0])
        (draw-picker state shader (:y @picker-state) [0 1 0])
        (draw-picker state shader (:z @picker-state) [0 0 1]))

      ;; finally read from all three buffers
      (let [x client-x
            y (- h client-y)]
        [(read-pixel gl (:x @picker-state) x y)
         (read-pixel gl (:y @picker-state) x y)
         (read-pixel gl (:z @picker-state) x y)]))))


(defn create-picker []
  (PointPicker. (atom {})))
