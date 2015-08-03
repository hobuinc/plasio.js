(ns renderer.core
  (:require [clojure.set :as set]
            [cljs-uuid.core :as uuid]
            [renderer.engine :as r]
            [renderer.engine.util :as u]
            [renderer.util :as ru]
            [renderer.log :as l]
            [renderer.events :refer [next-tick]]
            [cljs.core.async :as async])
  (:require-macros [cljs.core.async.macros :refer [go go-loop]]))

(def init-state {:view {:cameras []}
                 :display {:clear-color [0 0 0]
                           :render-options {}}})

(defn- do-startup [state]
  ;; Add the default camera to our renderer
  ;;
  (-> state
      (update-in [:view :cameras] conj {:active true
                                        :type "perspective"
                                        :fov 70})))

(defprotocol IPlasioRenderer
  (startup [this elem])
  (set-clear-color [this col] [this r g b])
  (add-camera [this props])
  (update-camera [this index f])
  (set-eye-position [this x y z] [this pos])
  (set-target-position [this x y z] [this pos])
  (add-scale-object [this uri x y z] [this uri pos])
  (remove-all-scale-objects [this])
  (add-prop-listener [this korks f])
  (remove-prop-listener [this id])
  (add-point-buffer [this id])
  (remove-point-buffer [this id])
  (add-loader [this loader])
  (remove-loader [this loader])
  (set-render-options [this opts])
  (pick-point [this x y])
  (pick-ui-point [this x y radius])
  (apply-state [this state])
  (resize-view! [this w h])
  (add-post-render [this f])
  (add-point [this id position state])
  (update-point [this id position state])
  (remove-point [this id])
  (remove-all-points [this])
  (create-line-strip [this id params])
  (push-line-strip-point [this id point-id])
  (insert-line-strip-point [this id point-id after-id])
  (remove-all-line-strips [this])
  (project-to-image [this projection-view-matrix coordinate-index resolution])
  (add-overlay [this id bounds image])
  (remove-overlay [this id])
  (add-label [this id position text])
  (remove-label [this id])
  (update-label [this id position text])
  (remove-all-labels [this]))

(defrecord PlasioRenderer [state render-engine]
  IPlasioRenderer
  (startup [this elem]
    (l/logi "Doing startup!")
    (let [rengine (r/make-engine)]
      (r/attach! rengine elem state)

      (l/logi "Setting up state!")
      (reset! render-engine rengine)
      (reset! state (do-startup init-state))))

  (add-camera [this props]
    (swap! state update-in [:view :cameras] conj props))

  (update-camera [this index props]
    (swap! state update-in [:view :cameras index] merge props))

  (set-clear-color [this r g b]
    (set-clear-color this [r g b]))

  (set-clear-color [this col]
    (swap! state assoc-in [:display :clear-color] col))

  (set-eye-position [this x y z]
    (set-eye-position this [x y z]))

  (set-eye-position [this pos]
    (swap! state assoc-in [:view :eye] pos))

  (set-target-position [this x y z]
    (set-target-position this [x y z]))

  (add-scale-object [this uri x y z]
    (l/logi "Adding scale object" uri x y z)
    (add-scale-object this uri [x y z]))

  (add-scale-object [this uri pos]
    (swap! state update-in [:scale-objects] conj [uri pos]))

  (remove-all-scale-objects [this]
    (swap! state assoc-in [:scale-objects] []))

  (set-target-position [this pos]
    (swap! state assoc-in [:view :target] pos))

  (add-prop-listener [this korks f]
    (let [id (str (uuid/make-random))
          korks (map keyword (u/safe-korks korks))]
                                        ; make sure the current value is sent on subscribe
      (go (f (clj->js (get-in @state korks))))
      (add-watch state id
                 (fn [_ _ os ns]
                   (let [v (get-in ns korks)
                         o (get-in os korks)]
                     (when-not (= v o)
                       (go (f (clj->js v)))))))
      id))

  (remove-prop-listener [this id]
    (remove-watch state id))

  (add-point-buffer [this id]
    ;; TODO: make sure that passed buffer is of javascript array buffer
    (swap! state update-in [:point-buffers] conj (ru/encode-id id)))

  (remove-point-buffer [this id]
    (swap! state update-in [:point-buffers]
           (fn [bufs]
             (remove #{(ru/encode-id id)} bufs))))

  (add-loader [this loader]
    (r/add-loader @render-engine loader))

  (remove-loader [this loader]
    (r/remove-loader @render-engine loader))

  (set-render-options [this opts]
    (swap! state update-in [:display :render-options] merge opts))

  (pick-point [_ x y]
    (r/pick-point @render-engine x y))

  (pick-ui-point [_ x y radius]
    (r/pick-ui-point @render-engine x y (or radius 20)))

  (apply-state [_ st]
    (reset! state st))

  (resize-view! [_ w h]
    (r/resize-view! @render-engine w h))

  (add-post-render [_ f]
    (r/add-post-render @render-engine f))

  (add-point [_ id position st]
    (swap! state update-in [:points] assoc id [position st]))

  (update-point [_ id position st]
    (swap! state update-in [:points id]
           (fn [[p s]]
             [(or position p)
              (or st s)])))

  (remove-point [_ id]
    (swap! state update-in [:points] dissoc id))

  (remove-all-points [_]
    (swap! state assoc-in [:points] {}))

  (create-line-strip [_ id params]
    (swap! state update-in [:line-strips] assoc id {:points []
                                                    :params params}))

  (push-line-strip-point [_ id point-id]
    (swap! state update-in [:line-strips id :points] conj point-id))

  (insert-line-strip-point [_ id point-id before-id]
    (swap! state update-in [:line-strips id :points]
           (fn [points]
             (let [[a b] (split-with #(not= before-id %) points)]
               (vec
                 (concat a [point-id] b))))))

  (remove-all-line-strips [_]
    (swap! state assoc-in [:line-strips] {}))

  (project-to-image [this mat which res]
    ;; projection using matrix mat, picks _which_ coordinate (0, 1, 2) and res is the output image size
    (r/project-to-image @render-engine mat which res))


  (add-overlay [this id bounds image]
    ;; add an overlay at the specified bounds, note that these bounds are not in point cloud space
    ;; but in world coordinates, where Y goes up and orgin is right at the middle of the point cloud
    ;;
    ;; TODO: At this point the overlays are passed down directly to the renderer.  They do not affect the
    ;; state.  Eventually it would be nice to gave the renderer call back into the features so that the renderer
    ;; could drive these things.
    ;;
    (r/add-overlay @render-engine id bounds image))

  (remove-overlay [this id]
    (r/remove-overlay @render-engine id))


  (add-label [this id position text]
    (swap! state update-in [:text-labels]
           (fnil conj [])
           [id position text]))

  (update-label [this id position text]
    (swap! state update-in [:text-labels]
           (fn [labels]
             ;; find the item we're interested in
             (let [[a b] (split-with (fn [[this-id _ _]]
                                       (not= id this-id))
                                     labels)]
               (if-let [item (first b)]
                 (do
                   (let [[_ pos t] item
                         updated (concat a
                                         [[id (or position pos) (or text t)]]
                                         (rest b))]
                     updated))
                 labels)))))


  (remove-label [this id]
    (swap! state update-in [:text-labels]
           (fn [labels]
             (->> labels
                  (remove #(-> %
                               first
                               (= id)))
                  vec))))

  (remove-all-labels [this]
    (swap! state assoc :text-labels [])))


(defn partial-js
  "Changes all passed arguments from javascript to clj types for easy mucking"
  [f this]
  (fn [& args]
    (let [c (js->clj args :keywordize-keys true)]
      (clj->js (apply f this c)))))

(defn partial-js-passthrough
  "Like partial-js but doesn't touch values"
  [f this]
  (fn [& args]
    (apply f this args)))

(defn ^:export createRenderer
  "Given a DOM element, initialize a renderer on it, also returns an object which
  can have methods invoked on it to do stuff with it"
  [elem]
  (let [r (PlasioRenderer. (atom {}) (atom nil))]
    (startup r elem)
    (clj->js {:addCamera (partial-js add-camera r)
              :updateCamera (partial-js update-camera r)
              :setClearColor (partial-js set-clear-color r)
              :setEyePosition (partial-js set-eye-position r)
              :setTargetPosition (partial-js set-target-position r)
              :addScaleObject (partial-js add-scale-object r)
              :removeAllScaleObjects (partial-js remove-all-scale-objects r)
              :addPropertyListener (partial-js add-prop-listener r)
              :removePropertyListener (partial-js remove-prop-listener r)
              :addPointBuffer (partial-js-passthrough add-point-buffer r)
              :removePointBuffer (partial-js-passthrough remove-point-buffer r)
              :addLoader (partial-js add-loader r)
              :setRenderOptions (partial-js set-render-options r)
              :pickPoint (partial-js pick-point r)
              :pickUIPoint (partial-js pick-ui-point r)
              :applyState (partial-js apply-state r)
              :setRenderViewSize (partial-js resize-view! r)
              :addPostRender (partial-js-passthrough add-post-render r)
              :addPoint (partial-js add-point r)
              :updatePoint (partial-js update-point r)
              :removePoint (partial-js remove-point r)
              :removeAllPoints (partial-js remove-all-points r)
              :createLineStrip (partial-js create-line-strip r)
              :pushLineStripPoint (partial-js push-line-strip-point r)
              :insertLineStripPoint (partial-js insert-line-strip-point r)
              :removeAllLineStrips (partial-js remove-all-line-strips r)
              :projectToImage (partial-js project-to-image r)
              :addOverlay (partial-js add-overlay r)
              :removeOverlay (partial-js remove-overlay r)
              :addLabel (partial-js add-label r)
              :updateLabel (partial-js update-label r)
              :removeLabel (partial-js remove-label r)
              :removeAllLabels (partial-js remove-all-labels r)})))
