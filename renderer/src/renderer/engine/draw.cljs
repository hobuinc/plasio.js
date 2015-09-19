(ns renderer.engine.draw
  (:require [cljs-webgl.constants.blending-factor-dest :as bf]
            [cljs-webgl.shaders :as shaders]
            [cljs-webgl.constants.data-type :as data-type]
            [cljs-webgl.constants.texture-target :as tt]
            [cljs-webgl.constants.texture-unit :as tu]
            [cljs-webgl.typed-arrays :as ta]
            [cljs-webgl.constants.buffer-object :as bo]
            [cljs-webgl.constants.draw-mode :as draw-mode]
            [cljs-webgl.buffers :as buffers]
            [cljs-webgl.constants.capability :as capability]))

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
            (if-let [loc (shaders/get-uniform-location gl shader (:name u))]
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

(defn draw-all-buffers [gl bufs scene-overlays shader
                        base-uniform-map proj mv ro width height draw-bbox?]
  (let [attrib-loc (partial shaders/get-attrib-location gl shader)
        known-attributes {"position" (attrib-loc "position")
                          "color" (attrib-loc "color")
                          "intensity" (attrib-loc "intensity")
                          "classification" (attrib-loc "classification")}
        overlay-texture-location (shaders/get-uniform-location gl shader "overlay")
        uniforms (uniforms-with-override
                   gl shader
                   base-uniform-map
                   (assoc ro
                     :screen [width height]
                     :projectionMatrix proj
                     :modelViewMatrix  mv))]
    ;; setup properties that won't change for each buffer
    ;;
    ;; Viewport, active shader
    (.viewport gl 0 0 width height)
    (.useProgram gl shader)

    ;; setup all uniforms which don't change frame to frame
    (doseq [[_ v] uniforms]
      (set-uniform gl v))

    (.disable gl (.-DEPTH_TEST gl))

    (doseq [{:keys [point-buffer image-overlay transform]} (sort-bufs bufs mv)]
      ;; if we have a loaded point buffer for this buffer, lets render it, we may still want to draw
      ;; the bbox if the point-buffer is not valid yet
      ;;
      (when point-buffer
        (let [total-points (:total-points point-buffer)
              stride (:point-stride point-buffer)
              gl-buffer (:gl-buffer point-buffer)

              ;; figure out our overlays
              overlays (->> scene-overlays
                            (take 8)
                            seq)]
          ;; override per buffer uniforms
          (set-uniform gl (override-uniform uniforms :modelMatrix (:model-matrix transform)))
          (set-uniform gl (override-uniform uniforms :offset (:offset transform)))
          (set-uniform gl (override-uniform uniforms :uvrange (:uv-range transform)))

          (when-let [ps (:point-size point-buffer)]
            (set-uniform gl (override-uniform uniforms :pointSize ps)))

          ;; setup textures if we need it
          (when image-overlay
            (doto gl
              (.activeTexture tu/texture0)
              (.bindTexture tt/texture-2d image-overlay)
              (.uniform1i overlay-texture-location 0)))

          ;; setup attributes
          (.bindBuffer gl bo/array-buffer gl-buffer)
          (doseq [[name offset size] (:attributes point-buffer)]
            (if-let [loc (get known-attributes name)]
              (doto gl
                (.enableVertexAttribArray loc)
                (.vertexAttribPointer loc size data-type/float false stride (* 4 offset)))
              (throw (js/Error. (str "Don't know anything about attribute: " name)))))

          ;; finally make the draw call
          #_(.enable gl capability/depth-test)
          (.drawArrays gl draw-mode/points 0 total-points)


          ;; disable bound vertex array
          (doseq [[name _ _] (:attributes point-buffer)]
            (let [loc (get known-attributes name)]
              (doto gl
                (.disableVertexAttribArray loc))))))

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

    (.enable gl (.-DEPTH_TEST gl))))
