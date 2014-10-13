(ns renderer.engine
  "The renderer engine, drawing stuff 24/7"
  (:require [renderer.engine.util :refer [safe-korks join-ks mk-vector
                                          mk-color set-vector tvstr]]
            [renderer.engine.shaders :refer [make-shader]]
            [renderer.engine.model-cache :as mc]
            [renderer.log :as l]
            [cljs.core.async :as async :refer [<!]]
            [clojure.set :as set])
  (:require-macros [cljs.core.async.macros :refer [go go-loop]]))


(defprotocol ICursor
  "A cursor represents a chunk of application state, updating this state
  causes the underlying state to update thereby triggering any watchers"
  (transact! [this korks f])
  (update! [this korks v])
  (sub-cursor [this korks])
  (app-root [this])
  (root [this ks]))

(defrecord StateCursor [root-state ks]
  ICursor
  (transact! [this korks f]
    (swap! root-state update-in (join-ks ks korks)
           (fn [old]
             (let [new-state (f old)]
               (l/logi "Transact!" (str this) ": " old "->" new-state)
               new-state))))
  (update! [this korks v]
    (l/logi "Update!" (str this) ": " v)
    (swap! root-state assoc-in (join-ks ks korks) v))
  (sub-cursor [this korks]
    (l/logi "Sub-cursor" (str this) ": " ks "->" korks ":" (join-ks ks korks))
    (StateCursor. root-state (join-ks ks korks)))
  (app-root [this]
    @root-state)
  (root [this ks]
    (get-in @root-state (safe-korks ks)))
  Object
  (toString [this]
    (str "<StateCursor " ks ">")))


(defprotocol IBuffer
  "A protocol spec a buffer, a buffer should/would release its contents once its loaded into the 3D engine
  e.g., also provides ways to fetch items"
  (clear-buffer! [this])
  (get-buffer [this]))

(defrecord Buffer [id buffer]
  IBuffer
  (clear-buffer! [_]
    (reset! buffer []))
  (get-buffer [_]
    @buffer))

(defn make-buffer [id buf]
  (Buffer. id (atom buf)))

(defprotocol IRenderEngine
  "The render engine protocol, implement if you want to use a different rendering
  engine, other than three.js"
  (init [this elem source-state])
  (sync-state [this state])
  (draw [this]))


(defn- sync-comp
  "Calls the provided function with the current run-state for the given sub-key"
  [cursor app-state ks f]
  (let [s (safe-korks ks)]
    (if-let [src (get-in app-state s)]
      (let [cur (sub-cursor cursor s)]
        (l/logi "SYNC-COMP" (str cur))
        (f cur src)))))


(defn- changes
  "Given a list of keys and a map where some of those keys may be in use, return the list
  of keys which are not in the map, and the list of VALUES for keys no longer in map"
  ([ks obj]
   (changes ks obj identity))
  ([ks obj hash-fn]
   (let [k        (set (map hash-fn ks))
         obj-keys (set (keys obj))
         new-keys (set/difference k obj-keys)
         del-keys (set/difference obj-keys k)]
     [(into [] new-keys) (into [] del-keys)])))

(defn- add-remove
  "Given a seq of new objects, current state where the new objects eventually end up, a hash function, this function
  calls back the create and destroy functions and finally returns a new object which has the new objects added and removed"
  [in-ks out-obj create-fn destroy-fn hash-fn]
  (let [[added-keys removed-keys] (changes in-ks out-obj hash-fn)
        added-map   (into {} (for [k in-ks] [(hash-fn k) k]))
        added-objects   (select-keys added-map added-keys)
        removed-objects (select-keys out-obj removed-keys)]
    ;; first delete all objects that need to go away
    ;;
    (doall (map destroy-fn (vals removed-objects)))
    ;; Now call create-fn on all new keys and add them to hashmap
    ;;
    (l/logi "I am going to create on" added-objects)
    (let [rn (into {} (for [[k v] added-objects] [k (create-fn v)]))]
      (-> (apply dissoc out-obj removed-keys)
          (merge rn)))))

(defn- mk-camera
  "Given properties of the camera, create a new camera"
  [props app-state]
  (let [camera-type (:type props)
        width       (:width app-state)
        height      (:height app-state)
        rangew      (/ width 2)
        fov         (if-let [fov (:fov props)] fov 60)
        rangeh      (/ height 2)]
    (if (= camera-type "perspective")
      (js/THREE.PerspectiveCamera. 60 (/ width height) 1 10000)
      (js/THREE.OrthographicCamera. rangew (- rangew)
                                    rangeh (- rangeh) 1 10000))))

(def ^:private large-vec (mk-vector 9999999999 9999999999 9999999999))
(def ^:private small-vec (mk-vector -9999999999 -9999999999 -9999999999))

(defn- update-cameras
  "Given the current run-state for cameras, state and the overall app state returns an updated
  list of cameras"
  [cursor state-cams]
  (transact! cursor []
             (fn [cams]
               (let [[newc oldc] (changes state-cams cams)
                     app-state (app-root cursor)
                     without-old-cams (apply dissoc cams oldc)]
                 ;; associate and create new cameras
                 (reduce #(assoc %1 %2 (mk-camera %2 app-state)) without-old-cams newc)))))

(defn- update-display-state
  "Update display properties"
  [cursor state-ds]
  ;; Render Color
  (l/logi "Updating display state!")
  (l/logi cursor)
  (transact! cursor :clear-color (fn [_] (mk-color (:clear-color state-ds)))))

(defn- place-camera
  "Given a camera object along with its position and target to look at
  configures the camera"
  [cam p t]
  (when (and cam p t)
    (l/logi "Placing camera" (tvstr p) " -> " (tvstr t))
    (.copy (.-position cam) p)
    (.lookAt cam t)))

(defn- create-or-update
  "Given two map like objects mdst and msrc, calls either fcreate or fupdate
  depending on whether mdst/korks exists or not, both the callbacks are passed
  values from msrc/korks, only that its the second parameter in case of fupdate
  and first in case of fcreate"
  [mdst msrc korks fcreate fupdate]
  (let [korks (safe-korks korks)
        src   (get-in msrc korks)]
    (when src (update-in mdst korks #(if % (fupdate % src) (fcreate src))))))

(defn- update-view-state
  "Update the view state"
  [cursor state-vs]
  (transact! cursor []
             (fn [v] (-> v
                         (create-or-update state-vs :eye #(apply mk-vector %) #(apply set-vector %1 %2))
                         (create-or-update state-vs :target #(apply mk-vector %) #(apply set-vector %1 %2))))))

(defn- add-model [cursor cache scene uri pos]
  (transact! cursor []
             (fn [_]
               (go (let [[g m] (<! (mc/get-model cache uri))
                         mat   (js/THREE.MeshFaceMaterial. m)
                         mesh  (js/THREE.Mesh. g mat)]
                     (set-vector (.-position mesh) pos)
                     (set-vector (.-scale mesh) 1 1 1)
                     (.add scene mesh)
                     (l/logi "Mesh added" mesh mat (tvstr (.-position mesh)))
                     (update! cursor [] mesh)))
               nil)))

(defn- map-attributes
  "Given a geometry buffer, adds attributes and returns an arr ay of arraybuffers"
  [geom total-points]
  (let [attrs {:position 3 :color 3 :intensity 1 :classification 1}]
    (into {} (for [[k s] attrs]
               (do (.addAttribute geom (name k) js/Float32Array total-points s)
                   [k (.-array (aget (.-attributes geom) (name k)))])))))

(defn- mad
  "A simple mad (multiply and add) operation, v * m + a"
  [v m a]
  (+ (* v m) a))

(defn- set-indexed
  "Set the given values starting at a certain offset"
  [arr offset & values]
  (loop [index 0
         v values]
    (if (seq v)
      (do
        (aset arr (mad offset 1 index) (first v))
        (recur (inc index) (rest v)))
      arr)))

(defn cp-elements [dest woff src roff len]
  (loop [i 0]
    (when (< i len)
      (aset dest (+ woff i) (aget src (+ roff i)))
      (recur (inc i)))))

(defn- pull-keys
  "Given a JS object and a list of keys, returns a seq of values associated with the keys"
  [obj & keys]
  (map #(aget obj %) keys))


(defn- make-geom-buffer
  "Makes a particle system out of given seq of points"
  [points]
  (let [total-points (quot (.-length points) 8)
        mn large-vec
        mx small-vec
        color-min large-vec
        color-max small-vec
        geom (js/THREE.BufferGeometry.)
        attrs (map-attributes geom total-points)]
    ;; Add all the points in
    (l/logi "Points" points)
    (loop [pcount 0
           rindex 0]
      (if (< pcount total-points)
        (let [woff (* 3 pcount)]
          ;; copy points
          (cp-elements (:position attrs) woff points rindex 3)
          (cp-elements (:color attrs) woff points (+ 3 rindex) 3)
          (cp-elements (:intensity attrs) pcount points (+ 6 rindex) 1)
          (cp-elements (:classification attrs) pcount points (+ 7 rindex) 1)
          (recur (inc pcount) (+ rindex 8)))
        geom))))

(defn- geom->particle-system
  [geom mat]
  (hash-map :ps (js/THREE.ParticleSystem. geom (:material mat))
            :mat mat))

(defn- make-particle-system
  [points]
  (-> points
      make-geom-buffer
      (geom->particle-system (make-shader))))

(defn- point-buffer->particle-system
  "Converts a point buffer from an external source into a partical system
  which can be loaded into a THREE renderer"
  [^Buffer buffer]
  (l/logi "Making particle system")
  (let [points (get-buffer buffer)
        ps (make-particle-system points)]
    (clear-buffer! buffer)
    ps))

(defn- update-scale-objects
  "Adds and removes scale objects from the scenegraph"
  [cursor state-so]
  (transact! cursor []
             (fn [so]
               (let [hash-fn (fn [[uri pos]] (keyword (apply str uri pos)))
                     root (app-root cursor)
                     scene (:scene root)
                     model-cache (:model-cache root)]
                 (add-remove state-so so
                             (fn [[uri pos]]
                               (let [hkey (hash-fn [uri pos])]
                                 (add-model (sub-cursor cursor hkey) model-cache scene uri pos)
                                 nil))
                             (fn [r]
                               (. scene remove r))
                             hash-fn)))))

(defn update-point-buffers
  "Adds or removes point buffers from scene"
  [cursor state-pb]
  (let [scene (root cursor :scene)]
   (transact! cursor []
             (fn [pb]
               (add-remove state-pb pb
                           (fn [n]
                             (let [ps (point-buffer->particle-system n)]
                               (. scene add (:ps ps))
                               ps))
                           (fn [d]
                             (. scene remove (:ps d)))
                           :id)))))
(def updaters
  [[:cameras update-cameras]
   [:display update-display-state]
   [:view update-view-state]
   [:scale-objects update-scale-objects]
   [:point-buffers update-point-buffers]])

(defn- sync-local-state
  "Given the current state of the renderer, updates the running state so that all
  needed componenets are created and added to the scene"
  [cursor new-state]
  ;; update cameras
  (doall
    (map (fn [[prop f]]
           (sync-comp cursor new-state prop f)) updaters)))

(defn- find-in-state [state ks pred]
  "Given a state, a key or a seq of keys, and a pred returns the first element, the key for which passes pred.
  The state/ks should be a map"
  (let [m (get-in state (if (seq? ks) ks [ks]))
        k (first (filter pred (keys m)))]
    (when k
      (m k))))

(defn- render-state
  "Given a running state, render it out"
  [state]
  (when-let [camera (find-in-state state :cameras :active)]
    (let [r   (:renderer state)
          s   (:scene state)
          vw  (:view state)
          ds  (:display state)]
      ;; Place the camera in the scene to view things right
      (when camera
        (place-camera camera (:eye vw) (:target vw)))

      ;; setup display properties
      (when-let [cc (:clear-color ds)]
        (.setClearColor r (.getHex cc)))

      ;; Render the scene to the default frame buffer
      (when (and r s camera)
        (.render r s camera nil true)))))

(defrecord THREERenderEngine []
  IRenderEngine
  (init [this elem source-state]
    (let [refresh-chan  (async/chan (async/sliding-buffer 1))
          state-update  (async/chan)
          width         (.-offsetWidth elem)
          height        (.-offsetHeight elem)
          scene         (js/THREE.Scene.)
          light         (js/THREE.AmbientLight. 0xFFFFFF)
          render        (js/THREE.WebGLRenderer. #js {:antialias false})]
      ;; basic scene setup
      ;;
      (.add scene light)
      (.setSize render width height)
      (set! (.-autoClear render) false)
      (.appendChild elem (.-domElement render))

      ;; start up the loop to refresh the chan
      (go-loop [state (<! refresh-chan)]
               (js/requestAnimationFrame #(render-state state))
               (recur (<! refresh-chan)))

      ;; setup whatever we can
      (let [run-state (atom {:render-target elem
                             :width width
                             :height height
                             :renderer render
                             :model-cache (mc/make-cache)
                             :scene scene})]
        ;; start up the loop to trigger updates of our local state
        (go-loop [state (<! state-update)]
                 (sync-local-state (StateCursor. run-state []) state)
                 (recur (<! state-update)))

        (add-watch run-state "__redraw"
                   (fn [_ _ _ new-state]
                     (async/put! refresh-chan new-state)))
        (assoc this
               :run-state run-state
               :state-update-chan state-update))))

  (sync-state [this state]
    (async/put! (:state-update-chan this) state))

  (draw [this]
    (render-state @(:run-state this))))


(defn make-engine
  "Create the default render engine"
  []
  (THREERenderEngine.))

