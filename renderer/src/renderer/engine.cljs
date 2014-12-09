(ns renderer.engine
  "The renderer engine, drawing stuff 24/7"
  (:require [renderer.engine.util :refer [safe-korks join-ks mk-vector
                                          mk-color set-vector tvstr]]
            [renderer.util :refer [add-framed-watch]]
            [renderer.engine.shaders :as shaders]
            [renderer.engine.model-cache :as mc]
            [renderer.engine.render :as r]
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
  (source-state [this] [this korks])
  (root [this ks]))

(defrecord StateCursor [root-state ks sstate]
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
    (StateCursor. root-state (join-ks ks korks) sstate))
  (app-root [this]
    @root-state)
  (root [this ks]
    (get-in @root-state (safe-korks ks)))
  (source-state [this]
    sstate)
  (source-state [this ks]
    (get-in sstate (safe-korks ks)))
  Object
  (toString [this]
    (str "<StateCursor " ks ">")))


(defprotocol IRenderEngine
  "The render engine protocol, implement if you want to use a different rendering
  engine, other than three.js"
  (attach! [this elem source-state])
  (pick-point [this x y]))


(defn- changes
  "Given a list of keys and a map where some of those keys may be in use, return the list
  of keys which are not in the map, and the list of VALUES for keys no longer in map"
  ([ks obj]
   (changes ks obj identity))
  ([ks obj hash-fn]
   (let [k        (set (map hash-fn ks))
         obj-keys (set (keys obj))
         new-keys (set/difference k obj-keys)
         del-keys (set/difference obj-keys k)
         unchanged (set/union k obj-keys)]
     [(into [] new-keys) (into [] del-keys) (into [] unchanged)])))

(defn- add-remove
  "Given a seq of new objects, current state where the new objects eventually end up, a hash function, this function
  calls back the create and destroy functions and finally returns a new object which has the new objects added and removed"
  ([in-ks out-obj create-fn destroy-fn update-fn hash-fn]
   (let [[added-keys removed-keys unchanged-keys] (changes in-ks out-obj hash-fn)
         added-map   (into {} (for [k in-ks] [(hash-fn k) k]))
         added-objects   (select-keys added-map added-keys)
         removed-objects (select-keys out-obj removed-keys)]
     ;; first delete all objects that need to go away
     ;;
     (doall (map destroy-fn (vals removed-objects)))
     ;; Now call create-fn on all new keys and add them to hashmap
     ;;
     (l/logi "I am going to create on" added-objects)
     (let [rn (into {} (for [[k v] added-objects] [k (create-fn v)]))
           cleaned (apply dissoc out-obj removed-keys)]
       (-> (into {} (for [[k v] cleaned] [k (update-fn v)]))
           (merge rn)))))
  ([in-ks out-obj create-fn destroy-fn hash-fn]
   (add-remove in-ks out-obj create-fn destroy-fn identity hash-fn)))

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

(defn- loader-for-id [id]
  (if-let [p (re-find #"^([a-z]+):.*" id)]
    (second p)
    (throw (js/Error. (str "Don't know how to get buffers for ID: " id)))))

(defn- load-buffer [loader id]
  (let [c (async/chan)]
    (.load loader id (fn [err data]
                       (if err
                         (async/close! c)
                         (async/onto-chan c [data]))))
    c))

(defn update-point-buffers
  "Adds or removes point buffers from scene"
  [cursor state-pb]
  (let [gl          (root cursor :gl)
        bcache      (root cursor :loaded-buffers)
        all-loaders (source-state cursor :loaders)]
    (transact! cursor []
               (fn [pb]
                 (add-remove state-pb pb
                             (fn [buffer-id]
                               (let [loader-id (loader-for-id buffer-id)
                                     loader (get all-loaders loader-id)]
                                 (if-not loader
                                   (throw (js/Error. (str "Don't know about a loader for: " loader-id))))
                                 (go (let [data (<! (load-buffer loader buffer-id))]
                                       ;; only add buffer if we still need it, the buffer could
                                       ;; have been removed while we were still downloading
                                       (transact! cursor [buffer-id]
                                                  (fn [v]
                                                    (when-not (nil? v)
                                                      (let [buf (r/create-buffer gl data)]
                                                        (swap! bcache assoc buffer-id buf)
                                                        (assoc v :buffer-key buffer-id)))))))
                                 {:visible true}))
                             (fn [{:keys [buffer-key]}]
                               (when-let [gl-buffer (get @bcache buffer-key)]
                                 (.deleteBuffer gl gl-buffer)
                                 (swap! bcache dissoc buffer-key)))
                             identity)))))

(defn- sync-local-state
  "Given the current state of the renderer, updates the running state so that all
  needed componenets are created and added to the scene"
  [cursor]
  ;; update point buffers
  (let [{:keys [point-buffers]} (source-state cursor)]
    (update-point-buffers (sub-cursor cursor [:point-buffers]) point-buffers)))

(defn- create-canvas-with-size [w h]
  (let [c (.createElement js/document "canvas")]
    (set! (.-width c) w)
    (set! (.-height c) h)
    c))

(defrecord WebGLRenderEngine [state]
  IRenderEngine
  (attach! [this elem source-state]
    (let [width         (.-offsetWidth elem)
          height        (.-offsetHeight elem)
          canvas        (create-canvas-with-size width height)
          context       (r/get-gl-context canvas)]
      ;; basic scene setup
      ;;
      (.appendChild elem canvas)

      ;; setup whatever we can
      (let [run-state (atom {:render-target elem
                             :width width
                             :height height
                             :gl context
                             :shader (shaders/create-shader context)
                             :picker (r/create-picker)
                             :loaded-buffers (atom {}) ;; cache of loaded buffers
                             :point-buffers {}})]
        ;; start watching states for changes
        (add-framed-watch
         run-state "__internal"
         (fn [_ _ _ new-state]
           (r/render-state (assoc new-state
                             :source-state @source-state))))

        (add-framed-watch
         source-state "__internal-ss"
         (fn [_ _ _ new-state]
           (sync-local-state (StateCursor. run-state [] new-state))))

        (reset! state
                {:run-state run-state
                 :source-state source-state}))))

  (pick-point [_ x y]
    (let [rs @(:run-state @state)
          rs (assoc rs :source-state @(:source-state @state))]
      (r/pick-point (:picker rs) rs x y))))


(defn make-engine
  "Create the default render engine"
  []
  (WebGLRenderEngine. (atom nil)))

