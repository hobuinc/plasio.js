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
  (set-eye-and-target-position [this eye target])
  (add-scale-object [this uri x y z] [this uri pos])
  (remove-all-scale-objects [this])
  (add-prop-listener [this korks f])
  (remove-prop-listener [this id])
  (add-point-buffer-batch [this ids])
  (remove-point-buffer-batch [this ids])
  (add-remove-point-buffers [this to-add-ids to-remove-ids])
  (add-loader [this loader])
  (remove-loader [this loader])
  (set-render-options [this opts])
  (pick-point [this x y])
  (apply-state [this state applier-id])
  (resize-view! [this w h])
  (add-post-render [this f])
  (add-line-segment [this id start-pos end-pos color])
  (update-line-segment [this id start-pos end-pos color])
  (remove-line-segment [this id])
  (remove-all-line-segments [this])
  (project-to-image [this projection-view-matrix coordinate-index resolution]))


(defn- my-swap! [atom f & args]
  (let [stripper (fn [st]
                   (let [new-state (apply f st args)]
                     (dissoc new-state
                             ;; all ids we want to be stripped out when we mutate state
                             :x-applier-id)))]
    (swap! atom stripper)))

(defrecord PlasioRenderer [state render-engine history-size]
  IPlasioRenderer 
  (startup [this elem]
    (l/logi "Doing startup!")
    (let [rengine (r/make-engine)]
      (r/attach! rengine elem state)

      (l/logi "Setting up state!")
      (reset! render-engine rengine)
      (reset! state (do-startup init-state))))

  (add-camera [this props]
    (my-swap! state update-in [:view :cameras] conj props))

  (update-camera [this index props]
    (my-swap! state update-in [:view :cameras index] merge props))

  (set-clear-color [this r g b]
    (set-clear-color this [r g b]))

  (set-clear-color [this col]
    (my-swap! state assoc-in [:display :clear-color] col))

  (set-eye-position [this x y z]
    (set-eye-position this [x y z]))

  (set-eye-position [this pos]
    (my-swap! state assoc-in [:view :eye] pos))

  (set-target-position [this x y z]
    (set-target-position this [x y z]))

  (add-scale-object [this uri x y z]
    (l/logi "Adding scale object" uri x y z)
    (add-scale-object this uri [x y z]))

  (add-scale-object [this uri pos]
    (my-swap! state update-in [:scale-objects] conj [uri pos]))

  (remove-all-scale-objects [this]
    (my-swap! state assoc-in [:scale-objects] []))

  (set-target-position [this pos]
    (my-swap! state assoc-in [:view :target] pos))

  (set-eye-and-target-position [this eye target]
    (my-swap! state update-in [:view]
              assoc :eye eye :target target))

  (add-prop-listener [this korks f]
    (let [id (str (uuid/make-random))
          korks (map keyword (u/safe-korks korks))]
                                        ; make sure the current value is sent on subscribe
      (go (f (clj->js (get-in @state korks))))
      (add-watch state id
                 (fn [_ _ os ns]
                   (let [v (get-in ns korks)
                         o (get-in os korks)]
                     (when-not (identical? v o)
                       (go (f (clj->js v)))))))
      id))

  (remove-prop-listener [this id]
    (remove-watch state id))

  (add-point-buffer-batch [this ids]
    ;; TODO: make sure that passed buffer is of javascript array buffer
    (my-swap! state update-in [:point-buffers]
              concat
              (map ru/encode-id (vec ids))))

  (remove-point-buffer-batch [this ids]
    (my-swap! state update-in [:point-buffers]
           (fn [bufs]
             (let [to-remove (->> ids
                                  vec
                                  (map ru/encode-id)
                                  set)]
               (remove to-remove bufs)))))

  (add-remove-point-buffers [this to-add-ids to-remove-ids]
    (my-swap! state update-in [:point-buffers]
              (fn [bufs]
                (let [to-remove-set (->> to-remove-ids
                                         vec
                                         (map ru/encode-id)
                                         set)]
                  (->> bufs
                       (remove to-remove-set)
                       (concat (map ru/encode-id (vec to-add-ids))))))))

  (add-loader [this loader]
    (r/add-loader @render-engine loader))

  (remove-loader [this loader]
    (r/remove-loader @render-engine loader))

  (set-render-options [this opts]
    (my-swap! state update-in [:display :render-options] merge opts))

  (pick-point [this x y]
    (r/pick-point @render-engine x y))

  (apply-state [this st applier-id]
    (reset! state (assoc st
                         :x-applier-id applier-id)))

  (resize-view! [this w h]
    (r/resize-view! @render-engine w h))

  (add-post-render [this f]
    (r/add-post-render @render-engine f))

  (add-line-segment [this id start end col]
    (my-swap! state update-in [:line-segments] conj [id start end col]))

  (update-line-segment [this id start end col]
    (my-swap! state update-in [:line-segments]
           (fn [segments]
             ;; find the item we're interested in
             (let [[a b] (split-with (fn [[this-id _ _ _]]
                                       (not= id this-id))
                                     segments)]
               (if-let [item (first b)]
                 (do
                   (let [[_ os oe ocol] item
                         updated(concat a
                                        [[id (or start os) (or end oe) (or col ocol)]]
                                        (rest b))]
                     updated))
                 segments)))))

  (remove-line-segment [this id]
    (my-swap! state update-in [:line-segments]
           (fn [lines]
             (remove #(-> %
                          first
                          (= id))
                     lines))))

  (remove-all-line-segments [this]
    (my-swap! state assoc :line-segments '()))

  (project-to-image [this mat which res]
    ;; projection using matrix mat, picks _which_ coordinate (0, 1, 2) and res is the output image size
    (r/project-to-image @render-engine mat which res)))

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
  [elem history-size]
  (let [history-size (or history-size 1000)
        r (PlasioRenderer. (atom {}) (atom nil) history-size)]
    (startup r elem)
    (clj->js {:addCamera (partial-js add-camera r)
              :updateCamera (partial-js update-camera r)
              :setClearColor (partial-js set-clear-color r)
              :setEyePosition (partial-js set-eye-position r)
              :setTargetPosition (partial-js set-target-position r)
              :setEyeAndTargetPosition (partial-js set-eye-and-target-position r)
              :addScaleObject (partial-js add-scale-object r)
              :removeAllScaleObjects (partial-js remove-all-scale-objects r)
              :addPropertyListener (partial-js add-prop-listener r)
              :removePropertyListener (partial-js remove-prop-listener r)
              :addPointBufferBatch (partial-js-passthrough add-point-buffer-batch r)
              :removePointBufferBatch (partial-js-passthrough remove-point-buffer-batch r)
              :addRemovePointBuffers (partial-js-passthrough add-remove-point-buffers r)
              :addLoader (partial-js add-loader r)
              :setRenderOptions (partial-js set-render-options r)
              :pickPoint (partial-js pick-point r)
              :applyState (partial-js apply-state r)
              :setRenderViewSize (partial-js resize-view! r)
              :addPostRender (partial-js-passthrough add-post-render r)
              :addLineSegment (partial-js add-line-segment r)
              :removeLineSegment (partial-js remove-line-segment r)
              :removeAllLineSegments (partial-js remove-all-line-segments r)
              :updateLineSegment (partial-js update-line-segment r)
              :projectToImage (partial-js project-to-image r)})))
