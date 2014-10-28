(ns renderer.engine.shaders
  "Shaders abstraction"
  (:require [cljs-webgl.shaders :as shaders]
            [cljs-webgl.constants.shader :as shader]))


(declare vertex-shader)
(declare frag-shader)

(defn create-shader [gl]
  (let [vs (shaders/create-shader gl shader/vertex-shader vertex-shader)
        fs (shaders/create-shader gl shader/fragment-shader frag-shader)]
    (shaders/create-program gl vs fs)))

(def vertex-shader
  "
  precision mediump float;

  uniform mat4  projectionMatrix;
  uniform mat4  modelViewMatrix;
  uniform mat4  modelViewProjectionMatrix;

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

      vec4 mvPosition = modelViewMatrix * vec4( fpos, 1.0 );
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
      col = vec4(mix(color_source, intensity_source, intensityBlend), 1.0);
  }")


(def frag-shader
  "
  precision mediump float;

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

