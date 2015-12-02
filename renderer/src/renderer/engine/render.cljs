(ns renderer.engine.render
  "State renderer"
  (:require [renderer.log :as l]
            [renderer.util :refer [tap]]
            [renderer.engine.util :as util]
            [renderer.engine.shaders :as s]
            [renderer.engine.attribs :as attribs]
            [renderer.engine.specs :as specs]
            [renderer.engine.draw :as draw]
            [cljs-webgl.context :as context]
            [cljs-webgl.shaders :as shaders]
            [cljs-webgl.constants.capability :as capability]
            [cljs-webgl.constants.blending-factor-dest :as bf]
            [cljs-webgl.constants.texture-target :as texture-target]
            [cljs-webgl.constants.data-type :as dt]
            [cljs-webgl.constants.framebuffer-object :as fbo]
            [cljs-webgl.constants.texture-filter :as tf]
            [cljs-webgl.constants.texture-target :as tt]
            [cljs-webgl.constants.texture-unit :as tu]
            [cljs-webgl.constants.texture-parameter-name :as tpn]
            [cljs-webgl.constants.texture-wrap-mode :as twm]
            [cljs-webgl.constants.pixel-format :as pf]
            [cljs-webgl.texture :as texture]
            [cljs-webgl.constants.draw-mode :as draw-mode]
            [cljs-webgl.constants.data-type :as data-type]
            [cljs-webgl.constants.buffer-object :as buffer-object]
            [cljs-webgl.constants.shader :as shader]
            [cljs-webgl.buffers :as buffers]
            [cljs-webgl.typed-arrays :as ta]
            [cljsjs.gl-matrix]))


(defn- to-rads [a]
  (* (/ a 180.0) js/Math.PI))

(defn- projection-matrix [gl cam width height]
  (let [m (.-proj gl)
        aspect (if (< width height) (/ height width) (/ width height))
        fov  (to-rads (or (:fov cam) 75))
        near (or (:near cam) 1.0)
        far  (or (:far cam) 10000.0)]
    (if (= (:type cam) "perspective")
      (js/mat4.perspective m fov aspect near far)
      (js/mat4.ortho m (/ width -2) (/ width 2) (/ height 2) (/ height -2) near far))))


(def up-vector (array 0 1 0))

(defn- mv-matrix [gl eye target]
  (let [m (.-mv gl)
        eye (apply array eye)
        target (apply array target)]
    (js/mat4.lookAt m eye target up-vector)))

(defn- mvp-matrix [gl proj mv]
  (let [m (.-mvp gl)]
    (js/mat4.multiply m proj mv)))

(defn get-gl-context [elem]
  (let [gl (context/get-context elem {:alpha false
                                      :premultiplied-alpha false})]
    (set! (.-proj gl) (js/Array 16))
    (set! (.-mv gl) (js/Array 16))
    (set! (.-mvp gl) (js/Array 16))
    gl))

(defn typed-array? [v]
  (let [t (type v)]
    (or (= t js/Float32Array)
        (= t js/Uint8Array))))

(defn- coerce [v typ]
  (let [v (if (or (sequential? v)
                  (typed-array? v)
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
      (uniform :modelMatrix :mat4 identity-matrix)

      (uniform :pointSize :float 1.0)
      (uniform :intensityBlend :float 0.0)
      (uniform :maxColorComponent :float 1.0)

      (uniform :rgb_f :float 0.0)
      (uniform :class_f :float 0.0)
      (uniform :map_f :float 0.0)
      (uniform :imap_f :float 0.0)
      (uniform :overlay_f :float 0.0)

      (uniform :intensity_f :float 0.0)
      (uniform :height_f :float 0.0)
      (uniform :iheight_f :float 0.0)

      (uniform :xyzScale :vec3 [1 1 1])
      (uniform :clampLower :float 0)
      (uniform :clampHigher :float 1)

      (uniform :colorClampLower :float 0)
      (uniform :colorClampHigher :float 1)

      (uniform :rampColorStart :vec3 [1 0 0])
      (uniform :rampColorEnd :vec3 [0 1 0])

      (uniform :zrange :vec2 [0 1])
      (uniform :uvrange :vec4 [0 0 1 1])
      (uniform :offset :vec3 [0 0 0])
      (uniform :klassRange :vec2 [0 1])
      (uniform :pointSizeAttenuation :vec2 [1 0])
      (uniform :screen :vec2 [1000 1000]) ;; not really but something
      #_(uniform :do_plane_clipping :int 0)
      (uniform :circularPoints :int 0)
      #_(uniform :planes :vec4 (repeat 24 0))
      (uniform :sceneOverlaysCount :int 0)))

(def ^:private picker-uniform-map
  (-> {}
      (uniform :projectionMatrix :mat4 identity-matrix)
      (uniform :modelViewMatrix :mat4 identity-matrix)
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

#_(defn- draw-all-buffers
  [gl bufs scene-overlays shader base-uniform-map proj mv render-options width height draw-bbox?]
  (let [attrib-loc (partial shaders/get-attrib-location gl shader)
        blend-func [bf/src-alpha bf/one-minus-src-alpha]
        viewport {:x 0
                  :y 0
                  :width width
                  :height height}
        uniforms (uniforms-with-override
                  base-uniform-map
                  (assoc render-options
                         :screen [width height]
                         :projectionMatrix proj
                         :modelViewMatrix  mv))]
    ;; The only two loaders we know how to handle right now are:
    ;;      point-buffer - The actual point cloud
    ;;      image-overlay - The overlay for this point-buffer

    (doseq [{:keys [point-buffer image-overlay transform]} bufs]
      ;; if we have a loaded point buffer for this buffer, lets render it, we may still want to draw
      ;; the bbox if the point-buffer is not valid yet
      ;;
      (when point-buffer
        (let [total-points (:total-points point-buffer)
              stride       (:point-stride point-buffer)
              gl-buffer    (:gl-buffer point-buffer)
              attribs      (mapv (fn [[name offset size]]
                                   {:location (attrib-loc name)
                                    :components-per-vertex size
                                    :type data-type/float
                                    :stride stride
                                    :offset (* 4 offset)
                                    :buffer gl-buffer}) (:attributes point-buffer))

              ;; when we have overlay image, pull it out
              textures (when image-overlay [{:texture image-overlay :name "overlay"}])

              ;; determine overrides for this buffer
              uniform-map (merge {:modelMatrix (:model-matrix transform) 
                                  :offset (:offset transform)
                                  :uvrange (:uv-range transform)}

                                 ;; along with basic stuff, if we have a point size override, apply that
                                 (when-let [ps (:point-size point-buffer)]
                                   {:pointSize ps}))

              ;; figure out our overlays
              overlays (->> scene-overlays
                            (take 8)
                            seq)]
          ;; cljs.webgl cannot currently handle mutliple texture units, lets set them up here
          ;;
          (when overlays
            ;; we have a shader limit of 8 overlays at this time
            ;; TODO, Auto Detect texture unit count
            (let [base-index 1
                  indices (take (count overlays)
                                (iterate inc base-index))] ;; base index is 1 since we want to leave texture0 untouched
              ;; activate all textures
              (doall
               (map
                (fn [texture-unit ovr]
                  (.activeTexture gl (+ tu/texture0 texture-unit))
                  (.bindTexture gl tt/texture-2d (:texture ovr)))
                indices
                overlays))

              ;; set the texture unit back to 0
              (.activeTexture gl tu/texture0)

              ;; we need to now set sampler information in our sceneOverlays struct
              (let [overlay-val (apply array indices)
                    uniform-loc (shaders/get-uniform-location gl shader "sceneOverlays")]
                (.uniform1iv gl uniform-loc (ta/int32 overlay-val)))

              ;; the supporting uniforms are also sort of complex to set, so lets just do that using the raw
              ;; gl api
              (let [blend-contributions (apply array (repeat 8 1.0))
                    all-bounds (apply array
                                      (mapcat :bounds overlays))
                    uniform-loc-conts (shaders/get-uniform-location gl shader "sceneOverlayBlendContributions")
                    uniform-loc-bounds (shaders/get-uniform-location gl shader "sceneOverlayBounds")]
                (.uniform1fv gl uniform-loc-conts (ta/float32 blend-contributions))
                (.uniform4fv gl uniform-loc-bounds (ta/float32 all-bounds)))))

          ;; draw this buffer
          (let [uniforms (uniforms-with-override uniforms
                                                 (assoc uniform-map
                                                        :sceneOverlaysCount (count overlays)))]
            (buffers/draw! gl
                           :shader shader
                           :draw-mode draw-mode/points
                           :viewport viewport
                           :first 0
                           :blend-func [blend-func]
                           :count total-points
                           :textures textures
                           :capabilities {capability/depth-test true}
                           :attributes attribs
                           :uniforms (vals uniforms))))) 
      ;; if we're supposed to render the bbox, render that too
      (when draw-bbox?
        ;; render the bounding box
        (.lineWidth gl 1)
        (when-let [params (:bbox-params transform)]
          (buffers/draw! gl
                         :shader (:shader params)
                         :draw-mode draw-mode/lines
                         :viewport viewport
                         :first 0
                         :count 24
                         :capabilities {capability/depth-test false}
                         ;; this uniform setup is a little weird because this is what it looks like behind the scenes, we're
                         ;; setting raw uniforms here
                         :uniforms [{:name "m" :type :mat4 :values (:model-matrix transform)}
                                    {:name "v" :type :mat4 :values mv}
                                    {:name "p" :type :mat4 :values proj}]
                         ;; just one attribute
                         :attributes [{:location (:position-location params)
                                       :components-per-vertex 3
                                       :type data-type/float
                                       :stride 12
                                       :offset 0
                                       :buffer (:buffer params)}]))))))

(defn- draw-buffer-for-picking
  [gl buffer shader base-uniform-map proj mv render-options width height]
  (let [{:keys [point-buffer transform]} buffer
        attribs    [{:buffer (:gl-buffer point-buffer)
                     :location (shaders/get-attrib-location gl shader "position")
                     :components-per-vertex 3
                     :type data-type/float
                     :stride (:point-stride point-buffer)
                     :offset 0}]
        blend-func [bf/one bf/zero]
        viewport {:x 0
                  :y 0
                  :width width
                  :height height}
        total-points (:total-points point-buffer)
        uniforms (uniforms-with-override
                  base-uniform-map
                  (assoc render-options
                    :offset (:offset transform)
                    :modelMatrix (:model-matrix transform)
                    :projectionMatrix proj
                    :modelViewMatrix  mv))]
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

(defn normalize-plane [arr]
  (let [f (/ 1.0 (js/vec3.length arr))
        normalized  (js/Array
                     (* (aget arr 0) f)
                     (* (aget arr 1) f)
                     (* (aget arr 2) f)
                     (* (aget arr 3) f))]
    normalized))

(defn cull-planes [proj mv]
  (let [mvi  (js/mat4.invert js/mat4.create mv)
        mvp  (js/mat4.multiply js/mat4.create proj mvi) ;; this is actually P*Vi (P = Projection, Vi = Inverse View)
        g    (fn [f op1 op2]
               (f (aget mvp op1) (aget mvp op2)))
        mg   (fn [f m a b]
               (f (* m (aget mvp a)) (aget mvp b)))]
    (map normalize-plane
         [(js/Array (g + 3 0) (g + 7 4) (g + 11 8) (g + 15 12)) ; left
          (js/Array (g - 3 0) (g - 7 4) (g - 11 8) (g - 15 12)) ; right

          (js/Array (g + 3 1) (g + 7 5) (g + 11 9) (g + 15 13)) ; top
          (js/Array (g - 3 1) (g - 7 5) (g - 11 9) (g - 15 13)) ; bottom

          (js/Array (g + 3 2) (g + 7 6) (g + 11 10) (g + 15 14)) ; near
          (js/Array (g - 3 2) (g - 7 6) (g - 11 10) (g - 15 14)) ; far
          ])))

(defn point-inside? [plane p]
  (let [v (+ (js/vec3.dot plane p) (aget plane 3))]
    (> v 0)))

(defn points-inside-plane? [points plane]
  (some identity
        (map #(point-inside? plane %) points)))

(defn- world->eye [mv p]
  (let [p (js/Array (aget p 0)
                    (aget p 1)
                    (aget p 2) 1)]
    (js/vec4.transformMat4 (js/Array 0 0 0 0) p mv)))

(defn all-points [mins maxs]
  (letfn [(corner [x y z]
            (let [p (js/Array
                     (aget (if (zero? x) mins maxs) 0)
                     (aget (if (zero? y) mins maxs) 1)
                     (aget (if (zero? z) mins maxs) 2))]
              p))]
    [(corner 0 0 0) (corner 0 0 1) (corner 0 1 0)
     (corner 0 1 1) (corner 1 0 0) (corner 1 0 1)
     (corner 1 1 0) (corner 1 1 1)]))

(defn- pp [[nx ny nz _] [x1 y1 z1] [x2 y2 z2]]
  [(if (> nx 0) x1 x2)
   (if (> ny 0) y1 y2)
   (if (> nz 0) z1 z2)])

(defn- plane-distances [mins maxs plane]
  (let [p1 (pp plane mins maxs)
        p2 (pp plane maxs mins)
        [nx ny nz d] plane
        dist (fn [[x y z]]
               (+ (* x nx) (* y ny) (* z nz) d))]
    [(dist p1) (dist p2)]))

(defn intersects-frustum? [planes mv a]
  (let [{:keys [mins maxs]} a
        mins (world->eye mv mins)
        maxs (world->eye mv maxs)]
    (not (some #(let [[d1 d2] %]
                  (and (< d1 0) (< d2 0)))
               (map plane-distances (repeat mins) (repeat maxs) planes)))))

(defn render-state
  "Render the state in its current form"
  [{:keys [source-state local-state] :as state}]
  (let [gl (:gl state)
        aloader (:attrib-loader state)
        [width height] (render-view-size state)
        cam (first (filter :active (get-in source-state [:view :cameras])))
        vw (:view source-state)
        dp (:display source-state)
        eye (or (:eye vw) [0 0 0])
        tar (or (:target vw) [0 0 0])
        proj (projection-matrix gl cam width height)
        mv   (mv-matrix gl eye tar)
        mvp  (mvp-matrix gl proj mv)
        ro (:render-options dp)
        hints (get-in local-state [:display :render-hints])]
    ; clear buffer
    (apply buffers/clear-color-buffer gl (concat (:clear-color dp) [1.0]))
    (buffers/clear-depth-buffer gl 1.0)

    (.enable gl (.-DEPTH_TEST gl))
    (.depthMask gl true)

    ; update any buffers that need to be, the outside world can request a refresh of
    ; a resource
    (attribs/check-rereify-all aloader gl)

    ; draw all loaded buffers
    (let [buffers-to-draw (sequence
                            (comp
                              (map :attribs-id)
                              (keep (partial attribs/attribs-in aloader))
                              (filter #(get-in % [:point-buffer :gl-buffer])))
                            (vals (:point-buffers state)))]
      (println (count buffers-to-draw) "/" (count (:point-buffers state)))

      (draw/draw-all-buffers gl buffers-to-draw
                             (-> (:scene-overlays state)
                                 vals)
                             (:shader state)
                             uniform-map
                             proj mv ro width height
                             hints
                             false))

    ;; if there are any planes to be drawn, draw them here
    ;;
    (when-let [planes (seq (:planes source-state))]
      (draw/prep-planes-state! gl)
      (doall
        (map (fn [[id [normal dist color opacity size]]]
               ;; draw the plane here
               (draw/draw-plane! gl mvp normal dist color opacity size))
             planes))
      (draw/unprep-planes-state! gl))


    #_(when-let [strips (-> state
                          :line-strips
                          :line-strips
                          vals
                          seq)]
      ;; we have line-strips to draw, so lets draw them
      (let [line-shader (s/create-get-line-shader gl)
            position-loc (shaders/get-attrib-location gl line-shader "position")]
        (doseq [s strips]
          (let [line-width (get-in s [:params :width] 3)
                gl-buffer (:gl-buffer s)
                line-mode (if (get-in s [:params :loop])
                            draw-mode/line-loop
                            draw-mode/line-strip)
                prims (.-prims gl-buffer)]
            (.lineWidth gl line-width)
            (buffers/draw! gl
                           :shader line-shader
                           :draw-mode line-mode
                           :viewport {:x 0 :y 0 :width width :height height}
                           :first 0
                           :blend-func [[bf/one bf/zero]] ; no contribution from what we have on screen, blindly color this
                           :count prims
                           :capabilities {capability/depth-test false}
                           :attributes [{:location position-loc
                                         :components-per-vertex 3
                                         :type data-type/float
                                         :stride 12
                                         :buffer gl-buffer}]
                           :uniforms [{:name "mvp" :type :mat4 :values mvp}
                                      {:name "color" :type :vec3 :values (ta/float32 (apply array [1 0 0]))}])))))

    #_(doseq [l (concat
                (-> state :text-labels vals)
                (mapcat :labels (-> state :line-strips :line-strips vals))
                (map :sum-label (-> state :line-strips :line-strips vals)))]
      (when-let [p (util/->screen (:position l) mvp width height)]
        (let [[x y _] p
              texture (-> l :texture :texture)
              w (-> l :texture :width)
              h (-> l :texture :height)]
          (util/draw-2d-sprite gl texture x y w h width height))))

    (when-let [points (-> source-state :points vals seq)]
      (let [textures (util/create-get-point-textures gl)]
        (doseq [p points]
          (let [[pos st] p
                st (keyword st)
                [x y _] (util/->screen pos mvp width height)]
            (util/draw-2d-sprite gl
                                 (get textures st (:normal textures))
                                 x y 20 20 width height)))))

    ; if there are any post render callback, call that
    (doseq [cb (:post-render state)]
      (cb gl mvp mv proj))))


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
    (.texParameteri gl texture-target/texture-2d tpn/texture-wrap-s twm/clamp-to-edge)
    (.texParameteri gl texture-target/texture-2d tpn/texture-wrap-t twm/clamp-to-edge)
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
        cam (first (filter :active (get-in source-state [:view :cameras])))
        vw (:view source-state)
        dp (:display source-state)
        eye (or (:eye vw) [0 0 0])
        tar (or (:target vw) [0 0 0])
        proj (projection-matrix gl cam width height)
        mv   (mv-matrix gl eye tar)
        ro (-> (:render-options dp)     ; picker rendering options don't need a ton of options
               (select-keys [:xyzScale :zrange :offset])
               (assoc :pointSize 10
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

(defn- read-pixels
  ([gl target x y]
   (read-pixels gl target x y 1 1))

  ([gl target x y width height]
   (let [buf (js/Uint8Array. (* 4 width height))]
     (read-pixels gl target x y width height (.-buffer buf))))

  ([gl target x y width height buffer]
   (let [buf (js/Uint8Array. buffer)]
     (.bindFramebuffer gl fbo/framebuffer (:fb target))
     (.readPixels gl x y width height pf/rgba dt/unsigned-byte buf)
     (.bindFramebuffer gl fbo/framebuffer nil)

     (js/Float32Array. buffer))))

(defn- mv-mat []
  (let [m (js/mat4.create)
        m (js/mat4.identity m)
        m (js/mat4.rotateX m m 1.5705)
        m (js/mat4.translate m m (array 0 0 -1000))]
    m))


(defn project-to-image [{:keys [source-state] :as state} proj which res]
  ;; create an offscreen buffer, render to it, read pixels and destroy all the things
  ;;
  (let [gl (:gl state)
        target-buffer (create-fb-buffer gl res res)
        shader (s/create-picker-shader gl)
        aloader (:attrib-loader state)
        mv identity-matrix
        dp (:display source-state)
        which (case which
                0 [1 0 0]
                1 [0 1 0]
                [0 0 1])
        ro (-> (:render-options dp)     ; picker rendering options don't need a ton of options
               (select-keys [:xyzScale :zrange :offset])
               (assoc :pointSize 1
                      :which which))]

    (js/console.log "projecting!" proj mv dp which)
    (.bindFramebuffer gl fbo/framebuffer (:fb target-buffer))

    (buffers/clear-color-buffer gl 0.0 0.0 0.0 0.0)
    (buffers/clear-depth-buffer gl 1.0)

    (doseq [{:keys [attribs-id]} (vals (:point-buffers state))]
      (when-let [buffer (attribs/attribs-in aloader attribs-id)]
        (draw-buffer-for-picking gl buffer shader
                                 picker-uniform-map
                                 proj mv ro res res)))

    (.bindFramebuffer gl fbo/framebuffer nil)

    (let [pxs (read-pixels gl target-buffer 0 0 res res)]
      (release-pick-buffers gl [target-buffer])
      pxs)))


(defprotocol IPointPicker
  (pick-point [this state x y]))


(defrecord PointPicker [picker-state]
  IPointPicker
  (pick-point [this {:keys [source-state] :as state} client-x client-y]
    (let [gl (:gl state)
          [w h] (render-view-size state)
          dirt (:dirt @picker-state)
          ;; dirty flag keeps track of whether we need to re-render the buffers
          clean? (and (identical? (:display dirt) (:display source-state))
                      (identical? (:view dirt) (:view source-state))
                      (identical? (:point-buffers dirt) (:point-buffers state))
                      (= (:width dirt) w)
                      (= (:height dirt) h))]

      ;; if we're not clean, we gotta re-render the points
      ;;
      (when-not clean?
        ;; first make sure we update our dirt state
        (swap! picker-state assoc :dirt {:display (:display source-state)
                                         :view (:view source-state)
                                         :point-buffers (:point-buffers state)
                                         :width w
                                         :height h})
        
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
          (let [bufs (create-pick-buffers gl w h)
                read-buffer-size (* 4 w h)]
            (swap! picker-state assoc
                   :width w
                   :height h
                   :rx (js/Float32Array. read-buffer-size)
                   :ry (js/Float32Array. read-buffer-size)
                   :rz (js/Float32Array. read-buffer-size)
                   :x (:x bufs)
                   :y (:y bufs)
                   :z (:z bufs))))
        ;; now go ahead and render the three buffers and read the point
        (let [shader (:shader @picker-state)]
          (draw-picker state shader (:x @picker-state) [1 0 0])
          (draw-picker state shader (:y @picker-state) [0 1 0])
          (draw-picker state shader (:z @picker-state) [0 0 1])

          ;; read all textures unti our buffers
          (read-pixels gl (:x @picker-state) 0 0 w h (.-buffer (:rx @picker-state)))
          (read-pixels gl (:y @picker-state) 0 0 w h (.-buffer (:ry @picker-state)))
          (read-pixels gl (:z @picker-state) 0 0 w h (.-buffer (:rz @picker-state))))) 

      ;; finally read from all three buffers
      (let [x client-x
            y (- h client-y)
            off (+ x (* y w))
            rp (fn [k]
                 (aget (k @picker-state) off))]
        [(rp :rx) (rp :ry) (rp :rz)]))))


(defn create-picker []
  (PointPicker. (atom {})))
