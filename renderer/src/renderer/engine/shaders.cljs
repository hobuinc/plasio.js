(ns renderer.engine.shaders
  "Shaders abstraction"
  (:require [cljs-webgl.shaders :as shaders]
            [cljs-webgl.constants.shader :as shader]
            [clojure.string :as s]))

(declare vertex-shader)
(declare frag-shader)

(declare vertex-shader-picker)
(declare frag-shader-picker)

(declare vertex-shader-edl)
(declare frag-shader-edl)

(declare bbox-vertex-shader)
(declare bbox-fragment-shader)

(declare line-vertex-shader)
(declare line-fragment-shader)

(declare line-handle-vertex-shader)
(declare line-handle-fragment-shader)

(declare plane-vertex-shader)
(declare plane-fragment-shader)

(declare sprite-vertex-shader)
(declare sprite-fragment-shader)


(defn- parse-uniform-name [nm]
  ;; webgl post-fixes [0] on all shaders which are arrays
  (s/replace nm #"\[\d\]$" ""))

(defn shader-uniforms-attribs [gl program]
  (let [uniform-count (.getProgramParameter gl program (.-ACTIVE_UNIFORMS gl))
        uniform-locs (into {}
                           (for [i (range uniform-count)
                                 :let [uniform (.getActiveUniform gl program i)
                                       name (parse-uniform-name (.-name uniform))
                                       loc (shaders/get-uniform-location gl program name)]]
                             [name loc]))
        attrib-count (.getProgramParameter gl program (.-ACTIVE_ATTRIBUTES gl))
        attrib-locs (into {}
                          (for [i (range attrib-count)
                                :let [attrib (.getActiveAttrib gl program i)
                                      name (parse-uniform-name (.-name attrib))
                                      loc (shaders/get-attrib-location gl program name)]]
                            [name loc]))]
    {:uniforms uniform-locs
     :attribs attrib-locs}))

(defn create-program
  "Returns a linked shader program composed of the compiled shader objects
   specified by the `shaders` parameter. Throws an error if the program was
   not linked successfully.  Same as what is provided by cljs-webgl, but reports
   errors when linking fails

  Relevant OpenGL ES reference pages:

  * [glCreateProgram](http://www.khronos.org/opengles/sdk/docs/man/xhtml/glCreateProgram.xml)
  * [glAttachShader](http://www.khronos.org/opengles/sdk/docs/man/xhtml/glAttachShader.xml)
  * [glLinkProgram](http://www.khronos.org/opengles/sdk/docs/man/xhtml/glLinkProgram.xml)"
  [gl-context & shaders]
  (let [program (.createProgram gl-context)]

    (doseq [shader shaders]
      (.attachShader gl-context program shader))

    (.linkProgram gl-context program)

    (when-not (shaders/get-program-parameter gl-context program shader/link-status)
      (throw (js/Error. (.getProgramLogInfo gl-context program))))

    (.useProgram gl-context program)
    program))

(defn- create-shader [gl]
  ;; make sure that needed extensions are addeded
  (let [vs (shaders/create-shader gl shader/vertex-shader vertex-shader)
        fs (shaders/create-shader gl shader/fragment-shader
                                  (if (.getExtension gl "EXT_frag_depth")
                                    (str "#define have_frag_depth\n\n" frag-shader)
                                    frag-shader))
        shader (create-program gl vs fs)]
    shader))


(defn- create-picker-shader [gl]
  (let [vs (shaders/create-shader gl shader/vertex-shader vertex-shader-picker)
        fs (shaders/create-shader gl shader/fragment-shader frag-shader-picker)]
    (shaders/create-program gl vs fs)))

(defn- create-edl-shader [gl]
  (let [vs (shaders/create-shader gl shader/vertex-shader vertex-shader-edl)
        fs (shaders/create-shader gl shader/fragment-shader frag-shader-edl)]
    (shaders/create-program gl vs fs)))

(defn- create-bbox-shader [gl]
  (let [vs (shaders/create-shader gl shader/vertex-shader bbox-vertex-shader)
        fs (shaders/create-shader gl shader/fragment-shader bbox-fragment-shader)
        s (shaders/create-program gl vs fs)]
    s))

(defn- create-line-shader [gl]
  (let [vs (shaders/create-shader gl shader/vertex-shader line-vertex-shader)
        fs (shaders/create-shader gl shader/fragment-shader line-fragment-shader)
        s (shaders/create-program gl vs fs)]
    s))

(defn- create-line-handle-shader [gl]
  (let [vs (shaders/create-shader gl shader/vertex-shader line-handle-vertex-shader)
        fs (shaders/create-shader gl shader/fragment-shader line-handle-fragment-shader)
        s (shaders/create-program gl vs fs)]
    s))

(defn- create-sprite-shader [gl]
  (let [vs (shaders/create-shader gl shader/vertex-shader sprite-vertex-shader)
        fs (shaders/create-shader gl shader/fragment-shader sprite-fragment-shader)
        s (shaders/create-program gl vs fs)]
    s))

(defn- create-plane-shader [gl]
  (let [vs (shaders/create-shader gl shader/vertex-shader plane-vertex-shader)
        fs (shaders/create-shader gl shader/fragment-shader plane-fragment-shader)
        s (shaders/create-program gl vs fs)]
    s))

(def ^:private shader-creator-map
  {:renderer create-shader
   :picker create-picker-shader
   :edl create-edl-shader
   :bbox create-bbox-shader
   :line create-line-shader
   :line-handle create-line-handle-shader
   :sprite create-sprite-shader
   :plane create-plane-shader})


(defprotocol IShaderContext
  (get-shader [_ which]))

(defrecord ShaderContext [context]
  IShaderContext
  (get-shader [_ which]
    (if-let [shader (get-in @context [:shaders which])]
      shader
      (if-let [f (get shader-creator-map which)]
        (let [gl (:gl-context @context)
              s (f gl)
              shader (merge {:shader s}
                            (shader-uniforms-attribs gl s))]
          (swap! context assoc-in [:shaders which] shader)
          shader)
        (throw (js/Error. (str "Unknown shader type requested: " which)))))))


(defn create-shader-context [context]
  (ShaderContext. (atom {:gl-context context})))


(def vertex-shader
  "
  precision mediump float;

  uniform mat4  projectionMatrix;
  uniform mat4  modelViewMatrix;
  uniform mat4  modelMatrix;

  uniform float pointSize;
  uniform vec3  offset;

  uniform vec3  xyzScale;

  uniform vec2  pointSizeAttenuation; // (actual size contribution, attenuated size contribution)
  uniform vec2  screen; // screen dimensions

  uniform int sceneOverlaysCount;

  uniform sampler2D sceneOverlays[8];
  uniform float sceneOverlayBlendContributions[8];
  uniform vec4 sceneOverlayBounds[8];

  uniform int highlightSegmentsCount;
  uniform vec4 segmentPlane[64];
  uniform vec4 segmentHalfPlane[64];
  uniform vec2 segmentWidths[64];

  uniform vec4 availableColors;
  uniform vec4 colorBlendWeights;
  uniform vec4 clampsLow, clampsHigh;
  
  uniform vec4 sourceClampsLow, sourceClampsHigh;

  uniform vec4 channelClampsPick0;
  uniform vec4 channelClampsPick1;
  uniform vec4 channelClampsPick2;
  uniform vec4 channelClampsPick3;
  
  uniform vec4 channelRampContribution;

  uniform vec3 channelColorRamp0Start;
  uniform vec3 channelColorRamp0End;

  uniform vec3 channelColorRamp1Start;
  uniform vec3 channelColorRamp1End;

  uniform vec3 channelColorRamp2Start;
  uniform vec3 channelColorRamp2End;

  uniform vec3 channelColorRamp3Start;
  uniform vec3 channelColorRamp3End;

  attribute vec3 position;
  attribute float color0, color1, color2, color3;

  varying vec3 out_color;
  varying vec3 fpos;

  varying float logDepth;


  void inregion(vec3 point, vec4 plane, vec4 planeHalf, vec2 segmentWidths, out float val) {
      vec2 dists = abs(vec2(dot(plane, vec4(point, 1.0)), dot(planeHalf, vec4(point, 1.0))));

      vec2 r = vec2(1.0, 1.0) - step(segmentWidths, dists);
      val = r.x * r.y;
  }

  const vec4 bitSh = vec4(256. * 256. * 256., 256. * 256., 256., 1.);
  const vec4 bitMsk = vec4(0.,vec3(1./256.0));
  
  vec4 decompressColor(float c) {
      vec4 comp = fract(c * bitSh);
      comp -= comp.xxyz * bitMsk;
      return vec4(comp.yzw, floor(c) / 256.0);
  }
  
  vec4 clampColor(vec4 color, vec4 clampPick, float destLow, float destHigh,
      vec3 channelColorRampStart, vec3 channelColorRampEnd) {
      // recover source value
      //
      float channelRangeLow = dot(clampPick, sourceClampsLow);
      float channelRangeHigh = dot(clampPick, sourceClampsHigh);

      vec4 sr = vec4((channelRangeHigh - channelRangeLow));
      vec4 sn = vec4(channelRangeLow);

      vec4 source = color * sr + sn;

      vec3 lowv = vec3(destLow);
      vec3 highv = vec3(destHigh + 0.00001);
  
      vec3 coeff = 1.0 / (highv - lowv);
      vec3 newGray = (source.rgb - lowv) * coeff;
  
      return vec4(mix(channelColorRampStart, channelColorRampEnd, newGray.r), color.a);
  }

  void main() {
     fpos = (position.xyz - offset);
     vec4 wpos = (modelMatrix * vec4(fpos, 1.0)) * vec4(xyzScale, 1.0);

     vec4 mvPosition = modelViewMatrix * wpos;
     gl_Position = projectionMatrix * mvPosition;

     logDepth = log2(-mvPosition.z);

     vec4 dcolor0 = decompressColor(color0);
     vec4 dcolor1 = decompressColor(color1);
     vec4 dcolor2 = decompressColor(color2);
     vec4 dcolor3 = decompressColor(color3);
  
     vec4 rcolor0 = clampColor(dcolor0, channelClampsPick0, clampsLow.x, clampsHigh.x, channelColorRamp0Start, channelColorRamp0End);
     vec4 rcolor1 = clampColor(dcolor1, channelClampsPick1, clampsLow.y, clampsHigh.y, channelColorRamp1Start, channelColorRamp1End);
     vec4 rcolor2 = clampColor(dcolor2, channelClampsPick2, clampsLow.z, clampsHigh.z, channelColorRamp2Start, channelColorRamp2End);
     vec4 rcolor3 = clampColor(dcolor3, channelClampsPick3, clampsLow.w, clampsHigh.w, channelColorRamp3Start, channelColorRamp3End);
  
     vec4 norm_color0 = mix(dcolor0, rcolor0, channelRampContribution.x);
     vec4 norm_color1 = mix(dcolor1, rcolor1, channelRampContribution.y);
     vec4 norm_color2 = mix(dcolor2, rcolor2, channelRampContribution.z);
     vec4 norm_color3 = mix(dcolor3, rcolor3, channelRampContribution.w);
  
     mat4 colors = mat4(norm_color0, norm_color1, norm_color2, norm_color3);
  
     float maxWeight = dot(availableColors, colorBlendWeights);
     vec4  channelF = colorBlendWeights / maxWeight;
  
     vec4  finalColor = colors * channelF;
  
     out_color = finalColor.rgb;

     // we now need to blend in the scene overlay colors
     //
     if (sceneOverlaysCount > 0) {
        for (int i = 0 ; i < 8; i ++) {
            if (i >= sceneOverlaysCount)
                break;

            // only if this vertex is in our bounds do we care to shade it
            //
            vec4 bounds = sceneOverlayBounds[i]; // bounds are x1z1x2z2 packing
            float contribution = sceneOverlayBlendContributions[i];
            if (contribution > 0.00 &&
                wpos.x >= bounds.x && wpos.x < bounds.z &&
                wpos.z >= bounds.y && wpos.z < bounds.w) {
                    // this vertex is in our view, lets shade it, first we need to figure the texture
                    // coordinates
                    //
                    vec2 uuvv = vec2(1.0 - (wpos.x - bounds.x) / (bounds.z - bounds.x),
                                     (wpos.z - bounds.y) / (bounds.w - bounds.y));

                    vec4 overlayColor = vec4(1.0, 1.0, 1.0, 1.0); //texture2D(sceneOverlays[i], uuvv);
                    out_color = mix(out_color, overlayColor.rgb, overlayColor.a * contribution);
            }
        }
     }

     if (highlightSegmentsCount > 0) {
         for (int i = 0 ; i < 64 ; i ++) {
             if (i >= highlightSegmentsCount)
                 break;

             vec4 plane = segmentPlane[i];
             vec4 planeHalf = segmentHalfPlane[i];
             vec2 segmentWidths = segmentWidths[i];

             // check this point for whether its inside this plane
             float val = 0.0;
             inregion(wpos.xyz, plane, planeHalf, segmentWidths, val);

             if (val > 0.0) {
                 out_color = mix(out_color, vec3(1.0, 1.0, 0.0), 0.5);
                 break;
             }
         }
     }

      float attenuatedPointSize = ((1.0 / tan(1.308/2.0)) * pointSize / (-mvPosition.z)) * screen.y / 2.0;
      gl_PointSize = dot(vec2(pointSize, attenuatedPointSize), pointSizeAttenuation);
  }")


(def vertex-shader-picker
  "precision mediump float;

   uniform mat4  projectionMatrix;
   uniform mat4  modelViewMatrix;
   uniform mat4  modelMatrix;

   uniform float pointSize;
   uniform vec3 xyzScale;
   uniform vec2 zrange;
   uniform vec3 offset;
   uniform vec3 which;

   attribute vec3 position;

   varying vec3 xyz;

   void main() {
       vec3 fpos = (position.xyz - offset);
       vec4 worldPos = (modelMatrix * vec4(fpos, 1.0)) * vec4(xyzScale, 1.0);
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
  uniform int do_plane_clipping, circularPoints;
  uniform float intensityBlend;

  uniform sampler2D overlay;

  varying vec3 out_color;
  varying vec3 fpos;
  varying float logDepth;

  void main() {
      if (circularPoints > 0) {
        float a = pow(2.0*(gl_PointCoord.x - 0.5), 2.0);
        float b = pow(2.0*(gl_PointCoord.y - 0.5), 2.0);
        float c = 1.0 - (a + b);

        if(c < 0.0){
            discard;
        }      

#if defined have_frag_depth
        // gl_FragDepthEXT = gl_FragCoord.z + 0.002*(1.0-pow(c, 1.0)) * gl_FragCoord.w;
#endif
      }
      gl_FragColor = vec4(out_color, logDepth);
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

(def vertex-shader-edl
  "precision mediump float;

   const vec2 scale = vec2(0.5, 0.5);

   attribute vec2 position;
   varying vec2 texUV;

   void main() {
       texUV = position * scale + scale;
       gl_Position = vec4(position, 0.0, 1.0);
   }")

(def frag-shader-edl
  "precision mediump float;
   uniform float screenWidth;
   uniform float screenHeight;
   uniform sampler2D colorMap;

   uniform float radius;
   uniform float edlStrength;


   varying vec2 texUV;

   float contribution(vec2 uv, float sourceDepth) {
       float d = texture2D(colorMap, uv).a;
       if (d != 0.0) {
         if (sourceDepth == 0.0) return 100.0;
         return max(0.0, sourceDepth - d);
       }
       return 0.0;
   }

   float response(vec2 uv, float depth, vec2 pixelSize) {
       float sum = 0.0;

       sum += contribution(uv + pixelSize * vec2(-1.0, -1.0) * radius, depth);
       sum += contribution(uv + pixelSize * vec2( 0.0, -1.0) * radius, depth);
       sum += contribution(uv + pixelSize * vec2( 1.0, -1.0) * radius, depth);
       sum += contribution(uv + pixelSize * vec2(-1.0,  0.0) * radius, depth);
       sum += contribution(uv + pixelSize * vec2( 1.0,  0.0) * radius, depth);
       sum += contribution(uv + pixelSize * vec2(-1.0,  1.0) * radius, depth);
       sum += contribution(uv + pixelSize * vec2( 0.0,  1.0) * radius, depth);
       sum += contribution(uv + pixelSize * vec2( 1.0,  1.0) * radius, depth);

       return sum / 8.0;
   }

   void main() {
     vec2 screenSize = vec2(screenWidth, screenHeight);
     vec2 pixelSize = vec2(1.0, 1.0) / screenSize;

     float depth = texture2D(colorMap, texUV).a;
     float r = response(texUV, depth, pixelSize);
     float shade = exp(-r * 300.0 * edlStrength);

	   gl_FragColor = vec4(texture2D(colorMap, texUV).rgb * shade, 1.0);
	 }")


(def bbox-vertex-shader
  "attribute vec3 pos; uniform vec3 offset; uniform mat4 p, v, m; void main() {
     vec3 fpos = (pos.xyz - offset);
     vec4 worldPos = (m * vec4(fpos, 1.0));
     vec4 mvPosition = v * worldPos;

     gl_Position = p * mvPosition;
   }")

(def bbox-fragment-shader
  "void main() { gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0); }")


;; Shader to draw lines, line coordinates are expected to be in world space
;; not point cloud space
(def line-vertex-shader
  "precision mediump float;

   uniform mat4  mvp;
   attribute vec3 position;

   void main() {
       gl_Position = mvp * vec4(position, 1.0);
   }")

(def line-fragment-shader
  "
  precision mediump float;

  uniform vec3 color;
  void main() {
      gl_FragColor = vec4(color, 1.0);
  }")


(def line-handle-vertex-shader
  "precision mediump float;

   uniform mat4  p;
   uniform vec2  loc;
   uniform float size;
   attribute vec3 position;

   varying vec2 texcoord;

   void main() {
       texcoord = position.xy * 0.5 + vec2(0.5, 0.5);
       vec3 offset = vec3(loc, 0.0);
       gl_Position = p * vec4(position * vec3(size, size, 1.0) + offset, 1.0);
   }")

(def line-handle-fragment-shader
  "
  precision mediump float;
  varying vec2 texcoord;
  uniform sampler2D sprite;

  void main() {
      vec4 col = texture2D(sprite, texcoord);
      if (col.a < 0.1) discard;
      gl_FragColor = vec4(col.rgb, 1.0);
  }")

(def sprite-vertex-shader
  "precision mediump float;

   uniform mat4  p;
   uniform vec2  loc;
   uniform vec2 size;
   attribute vec3 position;

   varying vec2 texcoord;

   void main() {
       texcoord = position.xy * 0.5 + vec2(0.5, 0.5);
       vec3 offset = vec3(loc, 0.0);
       gl_Position = p * vec4(position * vec3(size / 2.0, 1.0) + offset, 1.0);
   }")

(def sprite-fragment-shader
  "
  precision mediump float;
  varying vec2 texcoord;
  uniform sampler2D sprite;

  void main() {
      vec4 col = texture2D(sprite, texcoord);
      if (col.a < 0.1) discard;
      gl_FragColor = vec4(col.rgb, 1.0);
  }")

(def plane-vertex-shader
  "precision mediump float;

   uniform mat4  mvp;
   uniform mat4  world;

   attribute vec3  position;

   void main() {
       vec4 pos = vec4(position, 1.0);
       gl_Position = mvp * world * pos;
   }")

(def plane-fragment-shader
  "
  precision mediump float;

  uniform float opacity;
  uniform vec3  color;

  void main() {
      gl_FragColor = vec4(color, opacity);
  }")
