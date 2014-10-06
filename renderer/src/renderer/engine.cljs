(ns renderer.engine
  "The renderer engine, drawing stuff 24/7"
  (:require [renderer.engine.model-cache :as mc]
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
  (root [this]))

(defn safe-korks [a]
  (if (nil? a)
    []
    (if (sequential? a) a [a])))

(defn- join-ks [a b]
  (let [a (safe-korks a)
        b (safe-korks b)]
    (concat a b)))

(defrecord StateCursor [root-state ks]
  ICursor
  (transact! [this korks f]
    (swap! root-state update-in (join-ks ks korks)
           (fn [old]
             (let [new-state (f old)]
               (println "Transact!" (str this) ": " old "->" new-state)
               new-state))))
  (update! [this korks v]
    (println "Update!" (str this) ": " v)
    (swap! root-state assoc-in (join-ks ks korks) v))
  (sub-cursor [this korks]
    (println "Sub-cursor" (str this) ": " ks "->" korks ":" (join-ks ks korks))
    (StateCursor. root-state (join-ks ks korks)))
  (app-root [this]
    @root-state)
  (root [this]
    (get-in @root-state (safe-korks ks)))
  Object
  (toString [this]
    (str "<StateCursor " ks ">")))


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
        (println "SYNC-COMP" (str cur))
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

(defn- mk-vector
  "Creates a vector depending on number of arguments provided"
  ([x y] (js/THREE.Vector2. x y))
  ([x y z] (js/THREE.Vector3. x y z))
  ([x y z w] (js/THREE.Vector4. x y z w)))

(defn- set-vector
  "Updates the vector depending on the number of arguments provided"
  ([v [x y z]] (.set v x y z))
  ([v x y] (.set v x y))
  ([v x y z] (.set v x y z))
  ([v x y z w] (.set v x y z w)))

(defn- tvstr [o]
  (str "(" (.-x o) ", " (.-y o) ", " (.-z o) ")"))

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

(defn- mk-color
  ([col]
   (apply mk-color (take 3 col)))
  ([r g b]
   (js/THREE.Color. r g b)))

(defn- update-display-state
  "Update display properties"
  [cursor state-ds]
  ;; Render Color
  (println "Updating display state!")
  (println cursor)
  (transact! cursor :clear-color (fn [_] (mk-color (:clear-color state-ds)))))

(defn- place-camera
  "Given a camera object along with its position and target to look at
  configures the camera"
  [cam p t]
  (when (and cam p t)
    (println "Placing camera" (tvstr p) " -> " (tvstr t))
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
                     (println "Mesh added" mesh mat (tvstr (.-position mesh)))
                     (update! cursor [] mesh)))
               nil)))

(defn- update-scale-objects
  "Adds and removes scale objects from the scenegraph"
  [cursor state-so]
  (transact! cursor []
             (fn [so]
               (let [so (if (nil? so) {} so) ;; make sure we handle the case when there are no scale objects in run state
                     hash-fn (fn [[uri pos]] (keyword (apply str uri pos)))
                     [added-objects removed-objects] (changes state-so so hash-fn)
                     root (app-root cursor)
                     scene (:scene root)
                     model-cache (:model-cache root)
                     without-objects (apply dissoc so removed-objects)
                     hash-objs (into {} (for [s state-so] [(hash-fn s) s]))
                     added-objects (map #(get hash-objs %) added-objects)]
                 ;; Remove stuff which doesn't exist anymore
                 (doall (map #(.remove scene (get so %)) removed-objects))
                 (let [r (reduce #(let [[uri pos] %2
                                        hkey (hash-fn %2)
                                        cur (sub-cursor cursor hkey)]
                                    (add-model cur model-cache scene uri pos)
                                    (assoc %1 hkey nil))
                                 without-objects added-objects)]
                   r)))))

(def updaters
  [[:cameras update-cameras]
   [:display update-display-state]
   [:view update-view-state]
   [:scale-objects update-scale-objects]])

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

