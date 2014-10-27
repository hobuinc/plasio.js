(ns renderer.engine.shaders
  "Shaders abstraction"
  (:require [renderer.engine.util :refer [mk-vector mk-color safe-korks get-set]]))


(declare vertex-shader)
(declare frag-shader)

(defn- obj-in [obj korks]
  (reduce #(aget %1 (name %2)) obj (safe-korks korks)))

(defprotocol IShader
  (reset-uniform! [this korks v]))

(defn- coerce [t v]
  (condp = t
    :f v
    :i v
    :v2 (apply mk-vector v)
    :v3 (apply mk-vector v)
    :t  (throw (js/Error. "Texture loading support coming soon"))
    :c  (apply mk-color v)
    :v4v (mapv #(apply mk-vector %) v)))

(defrecord Shader [material props]
  IShader
  (reset-uniform! [this nm new-val]
    (let [typ (keyword (obj-in props [:uniforms nm :type]))]
      (get-set props [:uniforms nm :value] (coerce typ new-val)))))

(defn- uniform
  "Generates a uniform spec and assocs it into the given map"
  ([m nm typ]
   (let [defaults {:f 0.0
                   :i 0
                   :v2 (mk-vector 0 0)
                   :v3 (mk-vector 0 0 0)}]
     (uniform m nm typ (typ defaults))))
  ([m nm typ default]
   (assoc-in m [:uniforms nm] {:type (name typ) :value default})))

(defn- attribute
  "Generates a uniform spec and assocs it into the given map"
  ([m nm typ]
   (assoc-in m [:attributes nm] {:type (name typ) :value nil})))

(defn make-shader []
  (let [obj (clj->js
              (-> {}
                  (attribute :position :v3)
                  (attribute :color :c)
                  (attribute :intensity :f)
                  (attribute :classification :f)

                  (uniform :pointSize :f 1.0)
                  (uniform :intensityBlend :f 0.0)
                  (uniform :maxColorComponent :f 1.0)

                  (uniform :rgb_f :f 1.0)
                  (uniform :class_f :f 1.0)
                  (uniform :map_f :f 1.0)
                  (uniform :imap_f :f 1.0)

                  (uniform :intensity_f :f 0.0)
                  (uniform :height_f :f 0.0)
                  (uniform :iheight_f :f 0.0)

                  (uniform :xyzScale :v3 (mk-vector 1 1 1))
                  (uniform :clampLower :f 0)
                  (uniform :clampHigher :f 1)

                  (uniform :colorClampLower :f 0)
                  (uniform :colorClampHigher :f 1)

                  (uniform :zrange :v2)
                  (uniform :offsets :v3)
                  (uniform :map :t nil)
                  (uniform :klassRange :v2)
                  (uniform :do_place_clipping :i)
                  (uniform :planes :v4v (repeatedly 6 (partial mk-vector 0 0 0 0)))

                  (assoc :vertexShader vertex-shader)
                  (assoc :fragmentShader frag-shader)))]
    (map->Shader {:material (js/THREE.ShaderMaterial. obj)
                  :props obj})))

(def vertex-shader
  "
  uniform float pointSize;
  uniform float intensityBlend;
  uniform float maxColorComponent;

  uniform float rgb_f;
  uniform float intensity_f;
  uniform float class_f;
  uniform float height_f;
  uniform float iheight_f;
  uniform float map_f;
  uniform float imap_f;

  uniform vec3 xyzScale;

  uniform float clampLower;
  uniform float clampHigher;
  uniform float colorClampLower;
  uniform float colorClampHigher;
  uniform vec2  zrange;
  uniform vec3  offsets;
  uniform sampler2D map;
  uniform vec2  klassRange;

  attribute vec3 position;
  attribute vec3 color;
  attribute float intensity;
  attribute float classification;

  varying vec4 col;
  varying vec3 fpos;


  void main() {
      fpos = ((position.xyz - offsets) * xyzScale).xzy * vec3(-1, 1, 1);

      vec4 mvPosition = modelViewMatrix * vec4( 0, 0, 0, 1.0 );
      gl_Position = projectionMatrix * mvPosition;
      float nheight = (position.z - zrange.x) / (zrange.y - zrange.x);

      float nhclamp = (nheight - colorClampLower) / (colorClampHigher - colorClampLower);

      // compute color channels
      //
      vec3 norm_color = color / maxColorComponent;
      vec3 map_color = texture2D(map, vec2(nhclamp, 0.5)).rgb;
      vec3 inv_map_color = texture2D(map, vec2(1.0 - nhclamp, 0.5)).rgb;

      float iklass = (classification - klassRange.x) / (klassRange.y - klassRange.x);
      vec3 class_color = texture2D(map, vec2(iklass, 0.5)).rgb;

      // compute intensity channels
      float i = (intensity - clampLower) / (clampHigher - clampLower);
      vec3 intensity_color = vec3(i, i, i);


      vec3 height_color = vec3(nheight, nheight, nheight);
      vec3 inv_height_color = vec3(1.0 - nheight, 1.0 - nheight, 1.0 - nheight);

      // turn the appropriate channels on
      //
      vec3 color_source = norm_color * rgb_f +
                          class_color * class_f +
                          map_color * map_f +
                          inv_map_color * imap_f;

      vec3 intensity_source = intensity_color * intensity_f +
                              height_color * height_f +
                              inv_height_color * iheight_f;

      // blend and return
      gl_PointSize = pointSize;
      col = //vec4(mix(color_source, intensity_source, intensityBlend), 1.0);
  }")


(def frag-shader
  "
  uniform vec4 planes[6];
  uniform int do_plane_clipping;

  varying vec4 col;
  varying vec3 fpos;

  void main() {
      if (do_plane_clipping > 0) {
          for(int i = 0 ; i < 6 ; i ++) {
              if (dot(planes[i], vec4(fpos, 1.0)) < 0.0)
                  discard;
          }
      }

      gl_FragColor = col;
  }")

