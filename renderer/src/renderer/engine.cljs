(ns renderer.engine
  "The renderer engine, drawing stuff 24/7"
  (:require [renderer.engine.util :refer [safe-korks join-ks mk-vector
                                          mk-color set-vector tvstr]]
            [renderer.util :as util :refer [add-framed-watch]]
            [renderer.engine.util :as eutil]
            [renderer.engine.shaders :as shaders]
            [renderer.engine.model-cache :as mc]
            [renderer.engine.render :as r]
            [renderer.engine.attribs :as attribs]
            [renderer.stats :as stats]
            [renderer.log :as l]
            [cljs.core.async :as async :refer [<!]]
            [clojure.set :as set])
  (:require-macros [cljs.core.async.macros :refer [go go-loop]]
                   [renderer.macros :refer [with-profile]]))

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
  (attach! [this elem source-state local-state])
  (pick-point [this x y])
  (pick-ui-point [this x y radius])
  (add-loader [this loader])
  (remove-loader [this loader])
  (resize-view! [this w h])
  (add-post-render [this f])
  (project-to-image [this mat which res])
  (add-overlay [this id bounds image])
  (remove-overlay [this id])
  (get-loaded-buffers [this])
  (add-stats-listener [this which key f])
  (remove-stats-listener [this which key]))


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
         unchanged (set/intersection k obj-keys)]
     [(into [] new-keys) (into [] del-keys) (into [] unchanged)])))


(defn- print-them-nicely [added removed unchanged]
  (let [pid (fn [op id idx] (println " " op " " idx "  " id))]
    (println "Added:")
    (doall (map (partial pid "+") added (range)))
    (println "Removed:")
    (doall (map (partial pid "-") removed (range)))
    (println "Unchanged:")
    (doall (map (partial pid "~") unchanged (range)))))

(defn- add-remove
  "Given a seq of new objects, current state where the new objects eventually end up, a hash function, this function
  calls back the create and destroy functions and finally returns a new object which has the new objects added and removed"
  ([in-ks out-obj create-fn destroy-fn hash-fn]
     (let [[added-keys removed-keys unchanged-keys] (changes in-ks out-obj hash-fn)
           added-map   (into {} (for [k in-ks] [(hash-fn k) k]))
           added-objects   (select-keys added-map added-keys)
           removed-objects (select-keys out-obj removed-keys)]

       #_(print-them-nicely added-keys removed-keys unchanged-keys)

       ;; first delete all objects that need to go away
       ;;
       (let [removed (vals removed-objects)]
         (doall (map destroy-fn removed)))

       ;; Now call create-fn on all new keys and add them to hashmap
       ;;
       (let [rn (into {} (for [[k v] added-objects] [k (create-fn v)]))
             cleaned (apply dissoc out-obj removed-keys)
             ;; make sure when you call update, you give it the new input data
             ret (merge cleaned rn)]
         ret)))

  ([in-ks out-obj create-fn destroy-fn]
   (add-remove in-ks out-obj create-fn destroy-fn identity)))

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

(defn- load-resource [loader params]
  (let [c (async/chan)]
    (.load loader params (fn [err data]
                           (if err
                             (async/close! c)
                             (async/onto-chan c [data]))))
    c))

(defn- fetch-resource
  "Try to load the given resource, using the provided loader-id and parameters"
  [loader params]
  (go
    [(keyword (aget loader "provides")) (<! (load-resource loader params))]))

(defn- load-buffer-components
  "Load all components required for an ID, if they fail, just substitute a nil instead"
  [all-loaders buffer-id]
  (let [comps (js/Object.keys buffer-id)
        chans (for [loader-id comps
                    :let [loader (get all-loaders loader-id)]
                    :when loader]
                (fetch-resource loader (aget buffer-id loader-id)))]
    (async/into {} (async/merge chans))))

(defn update-stat-for! [stats stat-type id pb]
  (when-let [s (aget pb "stats" (name stat-type))]
    (when-let [st (get stats stat-type)]
      (stats/add-node! st id (js->clj s)))))

(let [stats-to-update #{:z :red :green :blue}]
  (defn update-stats! [stats id loaded-info]
    (when-let [pb (:point-buffer loaded-info)]
      (doseq [s stats-to-update]
        (update-stat-for! stats s id pb)))))

(defn update-point-buffers
  "Adds or removes point buffers from scene"
  [cursor state-pb]
  (let [gl            (root cursor :gl)
        stats         (root cursor :stats-collector)
        attrib-loader (root cursor :attrib-loader)
        all-loaders   (root cursor :loaders)]
    (transact! cursor []
               (fn [pb]
                 (add-remove state-pb pb
                             (fn [buffer-id]
                               (let [decoded-id (util/decode-id buffer-id)]
                                 (go (let [loaded-info (<! (load-buffer-components all-loaders decoded-id))]
                                       (update-stats! stats buffer-id loaded-info)
                                       (transact! cursor [buffer-id]
                                                  (fn [v]
                                                    (when-not (nil? v)
                                                      (let [attribs-id (attribs/reify-attribs attrib-loader gl loaded-info)]
                                                        (assoc v :attribs-id attribs-id))))))))
                               {:visible true})
                             (fn [buf]
                               (when-let [aid (:attribs-id buf)]
                                 (attribs/unreify-attribs attrib-loader gl aid))))))))

(defn update-labels
  [cursor state-labels]
  (let [gl (root cursor :gl)]
    (transact! cursor []
               (fn [labels]
                 (let [p (add-remove state-labels labels
                                     ;; instantiate a new label
                                     ;;
                                     (fn [[_ position text]]
                                       {:position position
                                        :text     text
                                        :texture  (eutil/create-text-texture gl text)})

                                     ;; destroy a label
                                     ;;
                                     (fn [label]
                                       (eutil/destroy-text-texture gl (:texture label))))]
                   p)))))

(defn change-set-for-points [new old]
  ;; only return the points which have changed:
  ;; 1. New points have changed
  ;; 2. Points which have been updated have changed
  ;; 3. Points which have been deleted have changed
  ;;
  (let [deleted (clojure.set/difference (-> old keys set) (-> new keys set))
        updated (->> new
                     keys
                     (remove #(identical? (get new %)
                                          (get old %)))
                     set)]
    (apply conj updated deleted)))

(defn labels-for-segments [gl points]
  (let [make-label (fn [[p1 p2]]
                     (let [a (apply array p1)
                           b (apply array p2)
                           center (vec (js/vec3.lerp (array 0 0 0) a b 0.5))
                           dist (js/vec3.distance a b)
                           text (.toFixed dist 2)]
                       {:position center
                        :text    text
                        :texture  (eutil/create-text-texture gl text)}))]
    (->> points
         (partition 2 1)
         (mapv make-label))))

(defn label-for-total [gl points]
  (let [distance (fn [[a b]]
                   (js/vec3.distance
                     (apply array a)
                     (apply array b)))
        total (->> points
                   (partition 2 1)
                   (map distance)
                   (apply +))
        position (->> points
                      (reduce (fn [t v]
                                (mapv + t v)) [0 0 0])
                      (mapv #(/ % (count points))))
        text (.toFixed total 2)]
    {:position position
     :text    text
     :texture  (eutil/create-text-texture gl text)}))

(defn update-line-strips
  [cursor state-line-strips state-points]
  (let [gl (root cursor :gl)]
    (transact! cursor []
               (fn [strips]
                 (let [old-strips (:line-strips strips)
                       old-points (:points strips)

                       current-strips (-> old-strips keys set)
                       new-strips (-> state-line-strips keys set)
                       added-strips (clojure.set/difference new-strips current-strips)
                       removed-strips (clojure.set/difference current-strips new-strips)
                       changed-strips (clojure.set/intersection new-strips current-strips)]
                   ;; dealing with unchanged-strips is more work, so lets just get done
                   ;; with removed strips first
                   ;;
                   (doall
                     (map (fn [key]
                            (let [buf (get-in old-strips [key :gl-buffer])]
                              (eutil/release-line-buffer gl buf)))
                          removed-strips))

                   ;; merge in any new strips and the modified strip items
                   (let [point-id->position (fn [ids]
                                              (->> ids
                                                   (map #(->> %
                                                              (get state-points)
                                                              first))
                                                   (remove nil?)))
                         make-assets (fn [points {:keys [showTotal showLengths]}]
                                       (hash-map
                                         :gl-buffer (eutil/make-line-buffer gl points)
                                         :labels (when showLengths
                                                   (labels-for-segments gl points))
                                         :sum-label (when showTotal
                                                      (label-for-total gl points))))
                         new-strips (merge
                                      (zipmap
                                        added-strips
                                        (map (fn [key]
                                               (let [info (get state-line-strips key)
                                                     params (:params info)
                                                     points (point-id->position (:points info))]
                                                 (merge info
                                                        (make-assets points params))))
                                             added-strips))


                                      ;; now deal with all the buffers which need to be updated
                                      (let [changed-points (change-set-for-points state-points old-points)
                                            strip-updated? (fn [a b]
                                                             (or (not (identical? (:points a) (:points b)))
                                                                 (not (identical? (:params a) (:params b)))
                                                                 (some changed-points (:points a))))]
                                        (zipmap
                                          changed-strips
                                          (map (fn [key]
                                                 (let [new (get state-line-strips key)
                                                       old (get old-strips key)]
                                                   (if (strip-updated? new old)
                                                     (let [points (point-id->position (:points new))
                                                           params (:params new)]
                                                       ;; release old line segment buffer
                                                       (when-let [buf (:gl-buffer old)]
                                                         (eutil/release-line-buffer gl buf))

                                                       ;; release old text labels
                                                       (when-let [labels (seq (:labels old))]
                                                         (doall (map #(->> %
                                                                           :texture
                                                                           (eutil/destroy-text-texture gl))
                                                                     labels)))

                                                       (merge new
                                                              (make-assets points params)))
                                                     old)))
                                               changed-strips))))]
                     {:line-strips new-strips
                      :points state-points}))))))

(defn- create-canvas-with-size [w h]
  (let [c (.createElement js/document "canvas")]
    (set! (.-width c) w)
    (set! (.-height c) h)
    c))

(defn- resize-canvas-to-size [canvas w h]
  (set! (.-width canvas) w)
  (set! (.-height canvas) h))

(defn- to-intersection [strips all-points fn-to-screen]
  (mapcat (fn [[lid {ps :points params :params}]]
            ;; if this line strip is a loop then we need to append the last point to the
            ;; the list of points to check for segments
            (let [points (if (:loop params)
                           (conj ps (first ps))
                           ps)
                  psx (keep (fn [id]
                              (when-let [loc (first (get all-points id))]
                                {:id              id
                                 :line-id         lid
                                 :location        loc
                                 :screen-location (fn-to-screen loc)}))
                            points)
                  segments (partition 2 1 psx)]
              segments))
          strips))


(defn- intersecting-point [[x y] points radius fn-to-screen]
  (let [within-radius? (fn [[_ _ [x' y' _]]]
                         (<
                           (js/vec2.distance (array x y)
                                             (array x' y'))
                           radius))
        distance (fn [[_ _ [x' y' _]]]
                   (js/vec2.distance (array x y)
                                     (array x' y')))]
    (some->> points
             seq
             (map (fn [[id [p _]]]
                    [id p (fn-to-screen p)]))
             (filter within-radius?)
             (sort-by distance)
             first)))

(defn intersecting-line [[x y] lines points radius fn-to-screen]
  (some->> (to-intersection lines points fn-to-screen)
           (map (fn [[start end]]
                  {:line-id  (:line-id start)
                   :start    (dissoc start :line-id)
                   :end      (dissoc end :line-id)
                   :distance (eutil/line-distance-to-point
                               [x y]
                               (:screen-location start)
                               (:screen-location end))}))
           (filter #(< (:distance %) radius))
           (sort-by :distance)
           first))

(defrecord WebGLRenderEngine [state]
  IRenderEngine
  (attach! [this elem source-state local-state]
    (let [width         (.-offsetWidth elem)
          height        (.-offsetHeight elem)
          canvas        (create-canvas-with-size width height)
          context       (r/get-gl-context canvas)]
      ;; basic scene setup
      ;;
      (.appendChild elem canvas)

      ;; setup whatever we can
      (let [run-state (atom {:render-count 0
                             :render-target elem
                             :width width
                             :height height
                             :gl context
                             :shader (shaders/create-shader context)
                             :picker (r/create-picker)
                             :attrib-loader (attribs/create-attribs-loader)
                             :stats-collector {:z (stats/make-stats)
                                               :red (stats/make-stats)
                                               :green (stats/make-stats)
                                               :blue (stats/make-stats)}
                             :loaders {}
                             :point-buffers {}
                             :screen-overlays {}})]
        ;; start watching states for changes
        (add-framed-watch
         run-state "__internal"
         (fn [_ _ _ new-state]
           (js/console.time "render-state")
           (r/render-state (assoc new-state
                             :source-state @source-state
                             :local-state @local-state))
           (js/console.timeEnd "render-state")))

        (add-framed-watch
         source-state "__internal-ss"
         (fn [_ _ old-state new-state]
           (let [cursor (StateCursor. run-state [] new-state)]
             ;; if buffers changed, update them
             (when-not (identical? (:point-buffers old-state) (:point-buffers new-state))
               (update-point-buffers (sub-cursor cursor [:point-buffers]) (:point-buffers new-state)))

             ;; if the labels changed update them
             (when-not (identical? (:text-labels old-state) (:text-labels new-state))
               (update-labels (sub-cursor cursor [:text-labels]) (:text-labels new-state)))

             ;; update line segments, if either the points change or the line-segments change
             ;; we need to update
             (when (or (not (identical? (:points old-state) (:points new-state)))
                       (not (identical? (:line-strips old-state) (:line-strips new-state))))
               (update-line-strips (sub-cursor cursor [:line-strips])
                                   (:line-strips new-state)
                                   (:points new-state)))

             ;; something still changed, so we need to make sure that renderer is updated, we do this
             ;; by increasing our render count
             (swap! run-state update-in [:render-count] inc))))

        (add-framed-watch
          local-state "__internal-ls"
          (fn [_ _ old-state new-state]
            ;; local state changes don't need much for now
            (swap! run-state update-in [:render-count] inc)))

        (reset! state
                {:run-state run-state
                 :source-state source-state}))))

  (pick-point [_ x y]
    (let [rs @(:run-state @state)
          rs (assoc rs :source-state @(:source-state @state))]
      (r/pick-point (:picker rs) rs x y)))

  (pick-ui-point [_ x y radius]
    (let [rs @(:run-state @state)
          width (:width rs)
          height (:height rs)
          gl (:gl rs)
          mvp (.-mvp gl)
          source-state @(:source-state @state)
          screen-fn #(eutil/->screen % mvp width height)]
      ;; we can get intersections with either points, line-strips or
      ;; shapes, we need to convey sufficient information to the caller
      ;;
      (if-let [point (intersecting-point [x y] (:points source-state) radius screen-fn)]
        ;; we got a point
        {:entity point
         :type :point}

        ;; no point, lets try a line
        (if-let [line (intersecting-line [x y]
                                         (:line-strips source-state)
                                         (:points source-state)
                                         radius
                                         screen-fn)]
          (let [line-id (:line-id line)
                ;; process all points for this segment into a point-id -> location map.
                all-points (->> (get-in source-state [:line-strips line-id :points])
                                ;; return pairs of [id location]
                                (map (fn [id]
                                       [id (first (get-in source-state [:points id]))])))
                prev (get-in line [:start :id])
                next (get-in line [:end :id])]
            {:entity {:id line-id
                      :prev prev
                      :next next
                      :all-points all-points}
             :type   :line})))))

  (add-loader [_ loader]
    (let [key (.-key loader)
          rs  (:run-state @state)]
      (when-not (aget loader "provides")
        (throw (js/Error. "The loader doesn't advertise what it provides")))
      (swap! rs update-in [:loaders] assoc key loader)))

  (remove-loader [_ loader]
    (let [key (.-key loader)
          rs  (:run-state @state)]
      (swap! rs update-in [:loaders] dissoc key)))

  (resize-view! [_ w h]
    (let [rs (:run-state @state)
          gl (:gl @rs)
          canvas (.-canvas gl)]
      (js/console.log "reiszing view!" w h)
      (resize-canvas-to-size canvas w h)
      (swap! rs merge {:width w :height h})))

  (add-post-render [_ f]
    (let [rs (:run-state @state)]
      (swap! rs update-in [:post-render] conj f)))

  (project-to-image [_ mat which res]
    ;; the mat here is used as a model view matrix, so make sure you know what you're passing
    ;; basically this will be passed down as projection matrix with view matrix being identity
    ;; which is the same as passing down mat view, the user is free to align this matrix whichever
    ;; way they prefer
    (let [rs @(:run-state @state)
          rs (assoc rs :source-state @(:source-state @state))]
      (r/project-to-image rs mat which res)))

  (add-overlay [_ id bounds image]
    (let [rs (:run-state @state)
          gl (:gl @rs)
          texture (eutil/create-texture gl image)]
      (swap! rs update-in [:scene-overlays] assoc id {:id id
                                                      :bounds bounds
                                                      :texture texture})))

  (remove-overlay [_ id]
    (let [rs (:run-state @state)]
      (when-let [overlay (get-in @rs [:scene-overlays id])]
        (eutil/destroy-texture (:gl @rs) (:texture overlay))
        (swap! rs update-in [:scene-overlays] dissoc id))))

  (get-loaded-buffers [_]
    (let [rs (:run-state @state)
          attrib-loader (:attrib-loader @rs)
          point-buffers (:point-buffers @rs)]
      (sequence
        (comp (map :attribs-id)
              (map #(attribs/attribs-in attrib-loader %))
              (remove nil?))
        (vals point-buffers))))

  (add-stats-listener [_ which key f]
    (let [rs @(:run-state @state)
          stats-collector (:stats-collector rs)]
      (when-let [s (get stats-collector (keyword which))]
        (stats/listen! s key f))))

  (remove-stats-listener [_ which key]
    (let [rs @(:run-state @state)
          stats-collector (:stats-collector rs)]
      (when-let [s (get stats-collector (keyword which))]
        (stats/unlisten! s key)))))


(defn make-engine
  "Create the default render engine"
  []
  (WebGLRenderEngine. (atom nil)))

