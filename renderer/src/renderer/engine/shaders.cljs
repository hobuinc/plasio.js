(ns renderer.engine.shaders
  "Shaders abstraction"
  (:require [cljs-webgl.shaders :as shaders]
            [cljs-webgl.constants.shader :as shader]))


(declare vertex-shader)
(declare frag-shader)

(declare vertex-shader-picker)
(declare frag-shader-picker)

(defn create-shader [gl]
  ;; make sure that needed extensions are addeded
  (let [vs (shaders/create-shader gl shader/vertex-shader vertex-shader)
        fs (shaders/create-shader gl shader/fragment-shader
                                  (if (.getExtension gl "EXT_frag_depth")
                                    (str "#define have_frag_depth\n\n" frag-shader)
                                    frag-shader))]
    (shaders/create-program gl vs fs)))


(defn create-picker-shader [gl]
  (let [vs (shaders/create-shader gl shader/vertex-shader vertex-shader-picker)
        fs (shaders/create-shader gl shader/fragment-shader frag-shader-picker)]
    (shaders/create-program gl vs fs)))

(def vertex-shader
  "
  precision mediump float;

  uniform mat4  projectionMatrix;
  uniform mat4  modelViewMatrix;
  uniform mat4  modelViewProjectionMatrix;
  uniform mat4  modelMatrix;

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
  uniform float overlay_f;

  uniform vec3 xyzScale;

  uniform float clampLower;
  uniform float clampHigher;
  uniform float colorClampLower;
  uniform float colorClampHigher;
  uniform vec2  zrange;
  uniform vec4  uvrange;
  uniform vec3  offset;
  uniform sampler2D map;
  uniform vec2  klassRange;

  uniform sampler2D overlay;

  attribute vec3 position;
  attribute vec3 color;
  attribute float intensity;
  attribute float classification;

  varying vec3 out_color;
  varying vec3 out_intensity;

  varying vec3 fpos;


  void main() {
      fpos = ((position.xyz - offset) * xyzScale).xzy * vec3(-1, 1, 1);

      vec4 mvPosition = modelViewMatrix * modelMatrix * vec4( fpos, 1.0 );
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

      vec2 uv = vec2(1.0 - (fpos.x - uvrange.x) / (uvrange.z - uvrange.x),
                     1.0 - (fpos.z - uvrange.y) / (uvrange.w - uvrange.y));
                     
      vec3 overlay_color = texture2D(overlay, uv).xyz;

      // turn the appropriate channels on
      //
      out_color = norm_color * rgb_f +
              class_color * class_f +
              map_color * map_f +
              inv_map_color * imap_f +
              overlay_color * overlay_f;

     //out_color = vec3(uv, 0.0);
              
      out_intensity = intensity_color * intensity_f +
                  height_color * height_f +
                  inv_height_color * iheight_f;

      //gl_PointSize = 2.0;
      gl_PointSize = (1.0 / tan(1.308/2.0)) * pointSize / (-mvPosition.z);
      gl_PointSize = gl_PointSize * 1000.0 / 2.0; 
  }")


(def vertex-shader-picker
  "precision mediump float;

   uniform mat4  projectionMatrix;
   uniform mat4  modelViewMatrix;
   uniform mat4  modelViewProjectionMatrix;
   uniform mat4  modelMatrix;

   uniform float pointSize;
   uniform vec3 xyzScale;
   uniform vec2 zrange;
   uniform vec3 offset;
   uniform vec3 which;

   attribute vec3 position;

   varying vec3 xyz;

   void main() {
       vec3 fpos = ((position.xyz - offset) * xyzScale).xzy * vec3(-1, 1, 1);
       vec4 worldPos = modelMatrix * vec4(fpos, 1.0);
       vec4 mvPosition = modelViewMatrix * worldPos;
       gl_Position = projectionMatrix * mvPosition;
       gl_PointSize = pointSize;
       xyz = which * worldPos.xyz;
   }")


(def frag-shader
  "
#if defined have_frag_depth
#extension GL_EXT_frag_depth : enable
#endif

  precision mediump float;

  uniform vec4 planes[6];
  uniform int do_plane_clipping;
  uniform float intensityBlend;

  uniform sampler2D overlay;

  varying vec3 out_color;
  varying vec3 out_intensity;
  varying vec3 fpos;

  void main() {
      if (do_plane_clipping > 0) {
          for(int i = 0 ; i < 6 ; i ++) {
              if (dot(planes[i], vec4(fpos, 1.0)) < 0.0)
                  discard;
          }
      }


      float a = pow(2.0*(gl_PointCoord.x - 0.5), 2.0);
  	  float b = pow(2.0*(gl_PointCoord.y - 0.5), 2.0);
      float c = 1.0 - (a + b);

   	  if(c < 0.0){
   	      discard;
   	  }      
#if defined have_frag_depth
      gl_FragDepthEXT = gl_FragCoord.z + 0.002*(1.0-pow(c, 1.0)) * gl_FragCoord.w;
#endif
      gl_FragColor = vec4(mix(out_color, out_intensity, intensityBlend), 1.0);
  }")

(def frag-shader-picker
  "precision mediump float;

   varying vec3 xyz;
   float shift_right(float v, float amt) {
       v = floor(v) + 0.5;
       return floor(v / exp2(amt));
   }

   float shift_left(float v, float amt) {
       return floor(v * exp2(amt) + 0.5);
   }

   float mask_last(float v, float bits) {
       return mod(v, shift_left(1.0, bits));
   }

   float extract_bits(float num, float from, float to) {
       from = floor(from + 0.5);
       to = floor(to + 0.5);
       return mask_last(shift_right(num, from), to - from);
   }

   vec4 encode_float(float val) {
       if (val == 0.0)
           return vec4(0, 0, 0, 0);


	   float sign = val > 0.0 ? 0.0 : 1.0;
	   val = abs(val);
       float exponent = floor(log2(val));
       float biased_exponent = exponent + 127.0;
       float fraction = ((val / exp2(exponent)) - 1.0) * 8388608.0;

       float t = biased_exponent / 2.0;
       float last_bit_of_biased_exponent = fract(t) * 2.0;
       float remaining_bits_of_biased_exponent = floor(t);

       float byte4 = extract_bits(fraction, 0.0, 8.0) / 255.0;
       float byte3 = extract_bits(fraction, 8.0, 16.0) / 255.0;
       float byte2 = (last_bit_of_biased_exponent * 128.0 + extract_bits(fraction, 16.0, 23.0)) / 255.0;
       float byte1 = (sign * 128.0 + remaining_bits_of_biased_exponent) / 255.0;
       return vec4(byte4, byte3, byte2, byte1);
   }

   void main() {
       float s = xyz.x + xyz.y + xyz.z;
	   gl_FragColor = encode_float(s); }")
