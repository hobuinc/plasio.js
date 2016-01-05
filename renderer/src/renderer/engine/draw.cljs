(ns renderer.engine.draw
  (:require [renderer.engine.shaders :as s]
            [cljs-webgl.constants.blending-factor-dest :as bf]
            [cljs-webgl.shaders :as shaders]
            [cljs-webgl.constants.data-type :as data-type]
            [cljs-webgl.constants.texture-target :as tt]
            [cljs-webgl.constants.texture-unit :as tu]
            [cljs-webgl.typed-arrays :as ta]
            [cljs-webgl.constants.buffer-object :as bo]
            [cljs-webgl.constants.draw-mode :as draw-mode]
            [cljs-webgl.buffers :as buffers]
            [cljs-webgl.constants.capability :as capability]
            [cljs-webgl.constants.buffer-object :as buffer-object]
            [renderer.engine.util :as eutil]))

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

(defn- uniforms-with-override [gl shader which-map opts]
  (let [uniforms (reduce
                   (fn [m [k v]]
                     (update-in m [k]
                                (fn [old]
                                  (if-let [typ (:type old)]
                                    (assoc old :values (coerce v typ))
                                    (throw (js/Error. (str "Don't know type for field: " k)))))))
                   which-map opts)]
    (->> uniforms
         (map (fn [[k u]]
            (if-let [loc (get-in shader [:uniforms (:name u)])]
              [k (assoc u :location loc)]
              (throw (js/Error. (str "Could not find uniform location for: " (:name u)))))))
         (into {}))))


(defn- override-uniform [uniforms key value]
  (if-let [curr (get uniforms key)]
    (assoc curr :values (coerce value (:type curr)))
    (throw (js/Error. (str "Trying to override unknown uniform: " (name key))))))

(defn ^:private set-uniform
  [gl-context {:keys [name type values transpose location]}]
  (when-not location
    (throw (js/Error. "Not sure what uniform you're trying to set, location is null")))

  (when-not values
    (throw (js/Error. "Not sure what values you're trying to set, they are null")))

  (let [uniform-location location]
    (case type
      :bool   (.uniform1fv gl-context uniform-location values)
      :bvec2  (.uniform2fv gl-context uniform-location values)
      :bvec3  (.uniform3fv gl-context uniform-location values)
      :bvec4  (.uniform4fv gl-context uniform-location values)
      :float  (.uniform1fv gl-context uniform-location values)
      :vec2   (.uniform2fv gl-context uniform-location values)
      :vec3   (.uniform3fv gl-context uniform-location values)
      :vec4   (.uniform4fv gl-context uniform-location values)
      :int    (.uniform1iv gl-context uniform-location values)
      :ivec2  (.uniform2iv gl-context uniform-location values)
      :ivec3  (.uniform3iv gl-context uniform-location values)
      :ivec4  (.uniform4iv gl-context uniform-location values)
      :mat2   (.uniformMatrix2fv gl-context uniform-location transpose values)
      :mat3   (.uniformMatrix3fv gl-context uniform-location transpose values)
      :mat4   (.uniformMatrix4fv gl-context uniform-location transpose values)
      nil)))


(defn size-f [mins maxs]
  (let [x1 (aget mins 0)
        x2 (aget maxs 0)
        y1 (aget mins 1)
        y2 (aget maxs 1)
        z1 (aget mins 2)
        z2 (aget maxs 2)]
    (+
      (* (- x1 x2) (- x1 x2))
      (* (- y1 y2) (- y1 y2))
      (* (- z1 z2) (- z1 z2)))))

(defn sort-bufs [bufs mv]
  ;; the buffers need to be sorted based on distance from eye
  ;;
  (let [tmp (js/vec4.create)]
    (sort-by
      (fn [{:keys [transform]}]
        (let [position (get-in transform [:source :position])
              pos (js/vec3.transformMat4 tmp position mv)]
          ;; our key-fn weighs priority based on how big something is, if its small
          ;; it needs to be renderered last
          (/ (- (aget pos 2))
             (size-f (:mins transform) (:maxs transform)))))
      bufs)))


(defn highlight-segs->shader-vals [segs]
  ;; given segs as collection of maps with :start, :end and :width, returns a construct
  ;; ready for GPU
  ;;
  (reduce
    (fn [{:keys [planes half-planes widths]} {:keys [start end width]}]
      (let [v (eutil/segment->cutting-planes start end width)]
        {:planes      (.concat planes (:plane v))
         :half-planes (.concat half-planes (:plane-half v))
         :widths      (.concat widths (:widths v))}))
    {:planes      (array)
     :half-planes (array)
     :widths      (array)}
    segs))

(defn draw-all-buffers [gl bufs scene-overlays highlight-segments
                        shader
                        base-uniform-map proj mv ro width height hints draw-bbox?]
  (let [uniforms (uniforms-with-override
                   gl shader
                   base-uniform-map
                   (assoc ro
                     :screen [width height]
                     :projectionMatrix proj
                     :modelViewMatrix  mv))
        overlays (->> scene-overlays
                      (take 8)
                      seq)]
    ;; setup properties that won't change for each buffer
    ;;
    ;; Viewport, active shader
    (.viewport gl 0 0 width height)
    (.useProgram gl (:shader shader))

    ;; setup all uniforms which don't change frame to frame
    (doseq [[_ v] uniforms]
      (set-uniform gl v))

    ;; if we have overlays, active texture units
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
              uniform-loc (get-in shader [:uniforms "sceneOverlays"])]
          (.uniform1iv gl uniform-loc (ta/int32 overlay-val)))

        ;; the supporting uniforms are also sort of complex to set, so lets just do that using the raw
        ;; gl api
        (let [blend-contributions (apply array (repeat 8 1.0))
              all-bounds (apply array
                                (mapcat :bounds overlays))
              overlay-count (get-in shader [:uniforms "sceneOverlaysCount"])
              loc-conts (get-in shader [:uniforms "sceneOverlayBlendContributions"])
              loc-bounds (get-in shader [:uniforms "sceneOverlayBounds"])]
          (.uniform1i gl overlay-count (count overlays))
          (.uniform1fv gl loc-conts (ta/float32 blend-contributions))
          (.uniform4fv gl loc-bounds (ta/float32 all-bounds)))))

    (when-let [high-segs (seq highlight-segments)]
      ;; if we have highlight segments, then we need to set the appropriate state for them
      (let [total (count high-segs)
            ;; convert the segments into something we can use to send down to the shader
            segment-values (highlight-segs->shader-vals high-segs)
            ;; get the uniform locations out
            segment-count-loc (get-in shader [:uniforms "highlightSegmentsCount"])
            planes-loc (get-in shader [:uniforms "segmentPlane"])
            half-planes-loc (get-in shader [:uniforms "segmentHalfPlane"])
            widths-loc (get-in shader [:uniforms "segmentWidths"])]
        (.uniform1i gl segment-count-loc total)
        (.uniform4fv gl planes-loc (ta/float32 (:planes segment-values)))
        (.uniform4fv gl half-planes-loc (ta/float32 (:half-planes segment-values)))
        (.uniform2fv gl widths-loc (ta/float32 (:widths segment-values)))))

    (when (:flicker-fix hints)
      (.disable gl (.-DEPTH_TEST gl)))

    (doseq [{:keys [point-buffer transform]} (sort-bufs bufs mv)]
      ;; if we have a loaded point buffer for this buffer, lets render it, we may still want to draw
      ;; the bbox if the point-buffer is not valid yet
      ;;
      (when point-buffer
        (let [total-points (:total-points point-buffer)
              stride (:point-stride point-buffer)
              gl-buffer (:gl-buffer point-buffer)]
          ;; override per buffer uniforms
          (set-uniform gl (override-uniform uniforms :modelMatrix (:model-matrix transform)))
          (set-uniform gl (override-uniform uniforms :offset (:offset transform)))
          (set-uniform gl (override-uniform uniforms :uvrange (:uv-range transform)))

          (when-let [ps (:point-size point-buffer)]
            (set-uniform gl (override-uniform uniforms :pointSize ps)))

          ;; setup attributes
          (.bindBuffer gl bo/array-buffer gl-buffer)
          (doseq [[name offset size] (:attributes point-buffer)]
            (if-let [loc (get-in shader [:attribs name])]
              (doto gl
                (.enableVertexAttribArray loc)
                (.vertexAttribPointer loc size data-type/float false stride (* 4 offset)))
              (throw (js/Error. (str "Don't know anything about attribute: " name)))))

          ;; finally make the draw call
          #_(.enable gl capability/depth-test)
          (.drawArrays gl draw-mode/points 0 total-points)

          ;; disable bound vertex array
          (doseq [[name _ _] (:attributes point-buffer)]
            (when-let [loc (get-in shader [:attribs name] name)]
              (.disableVertexAttribArray gl loc)))))

      ;; if we're supposed to render the bbox, render that too
      (when draw-bbox?
        ;; render the bounding box
        (.lineWidth gl 1)
        (when-let [params (:bbox-params transform)]
          (buffers/draw! gl
                         :shader (:shader params)
                         :draw-mode draw-mode/lines
                         :viewport {:x 0 :y 0 :width width :height height}
                         :first 0
                         :count 24
                         :capabilities {capability/depth-test false}
                         ;; this uniform setup is a little weird because this is what it looks like behind the scenes, we're
                         ;; setting raw uniforms here
                         :uniforms [{:name "m" :type :mat4 :values (:model-matrix transform)}
                                    {:name "v" :type :mat4 :values mv}
                                    {:name "p" :type :mat4 :values proj}]
                         ;; just one attribute
                         :attributes [{:location              (:position-location params)
                                       :components-per-vertex 3
                                       :type                  data-type/float
                                       :stride                12
                                       :offset                0
                                       :buffer                (:buffer params)}]))))


    (when (:flicker-fix hints)
      (.enable gl (.-DEPTH_TEST gl)))))


(let [geom (atom nil)]
  (defn- planes-geom [gl]
    (or @geom
        (let [buf (ta/float32 [-1 0 -1
                                1 0 -1
                                1 0 1
                               -1 0 -1
                                1 0 1
                               -1 0 1])
              gl-buffer (buffers/create-buffer gl
                                               buf
                                               buffer-object/array-buffer
                                               buffer-object/static-draw)]
          (reset! geom gl-buffer)))))

;; plane rendering stuff
(defn prep-planes-state! [gl]
  (let [geom (planes-geom gl)
        {:keys [shader attribs]} (s/create-get-plane-shader gl)]
    ;; setup vertex pointer
    (doto gl
      (.enable (.-BLEND gl))
      (.blendFunc (.-SRC_ALPHA gl) (.-ONE_MINUS_SRC_ALPHA gl))
      (.useProgram shader)
      (.bindBuffer bo/array-buffer geom)
      (.vertexAttribPointer (:position attribs) 3 data-type/float false 0 0)
      (.enableVertexAttribArray (:position attribs)))))

(defn unprep-planes-state! [gl]
  ;; reverse the state here
  (let [{a :attribs} (s/create-get-plane-shader gl)]
    (doto gl
      (.disable (.-BLEND gl))
      (.disableVertexAttribArray (:position a))
      (.bindBuffer bo/array-buffer nil))))

(let [m (js/vec3.create)
      na (js/vec3.create)                                   ;
      nb (js/vec3.create)]
  (defn rot-a->b [a b]
    ;; given two vectors find the axis of rotation and angle of rotation
    ;; between then
    (js/vec3.normalize na a)
    (js/vec3.normalize nb b)

    (let [angle (js/Math.acos (js/vec3.dot na nb))]
      (if (< angle 0.00001)
        [a 0]
        [(js/vec3.cross m a b) angle]))))

(let [m (js/mat4.create)
      s (js/mat4.create)
      r (js/mat4.create)
      temp (js/mat4.create)
      t (js/mat4.create)]
  (defn- plane-world-matrix [normal dist size]
    (let [[axis angle] (rot-a->b (array 0 1 0)
                                 (apply array normal))]
      (js/mat4.identity m)
      (js/mat4.identity s)
      (js/mat4.identity r)
      (js/mat4.identity t)

      (js/mat4.multiply
        m
        (js/mat4.rotate r r angle axis)
        (js/mat4.multiply
          temp
          (js/mat4.translate t t (array 0 dist 0))
          (js/mat4.scale s s (array size size size)))))))

(defn draw-plane! [gl mvp normal dist color opacity size]
  (let [{u :uniforms} (s/create-get-plane-shader gl)
        world (plane-world-matrix normal dist size)]
    (doto gl
      (.uniform1f (:opacity u) opacity)
      (.uniform3fv (:color u) (ta/float32 color))
      (.uniformMatrix4fv (:world u) false world)
      (.uniformMatrix4fv (:mvp u) false mvp)

      (.drawArrays draw-mode/triangles 0 6))))

