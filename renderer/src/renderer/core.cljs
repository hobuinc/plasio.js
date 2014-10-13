(ns renderer.core
  (:require [clojure.set :as set]
            [renderer.engine :as r]
            [renderer.log :as l]))

(def init-state {:render-target nil
                 :cameras []
                 :display {:clear-color [0 0 0]}
                 :scale-objects []
                 :data {:batches []}})

(defn- do-startup [state]
  ;; Add the default camera to our renderer
  ;;
  (-> state
      (update-in [:cameras] conj {:active true
                                  :type "perspective"
                                  :fov 60})))

(defprotocol IPlasioRenderer
  (startup [this elem])
  (set-clear-color [this col] [this r g b])
  (add-camera [this props])
  (set-eye-position [this x y z] [this pos])
  (set-target-position [this x y z] [this pos])
  (add-scale-object [this uri x y z] [this uri pos])
  (remove-all-scale-objects [this])
  (add-point-buffer [this id buffer])
  (remove-point-buffer [this id]))

(defrecord PlasioRenderer [state]
  IPlasioRenderer
  (startup [this elem]
    (l/logi "Doing startup!")
    (let [rengine (-> (r/make-engine)
                      (r/init elem state))]

      (l/logi "Have engine");
      ;; Add some state listeners to auto-trigger redraw
      (add-watch state "__watcher"
                 (fn [_ _ _ new-state]
                   (l/logi "state changed to:" new-state)
                   (r/sync-state rengine new-state)))
      ;; jump start stuff by setting our state from init-state
      (l/logi "Setting up state!")
      (reset! state (do-startup init-state))))

  (add-camera [this props]
    (swap! state update-in [:cameras] conj props))

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

  (add-point-buffer [this id buffer]
    ;; TODO: make sure that passed buffer is of javascript array buffer
    (when-not (= (type buffer) js/Float32Array)
      (throw (js/Error. "Only Float32Array types are expected for adding buffers")))
    (swap! state update-in [:point-buffers] conj (r/make-buffer id buffer)))

  (remove-point-buffer [this id]
    (l/logi "Removing buffer with id" id)
    (l/logi "Buffers" (get-in @state [:point-buffers]))
    (swap! state update-in [:point-buffers]
           (fn [bufs]
             (remove #(= (:id %) id) bufs)))))

(defn partial-js
  "Changes all passed arguments from javascript to clj types for easy mucking"
  [f this]
  (fn [& args]
    (let [c (js->clj args :keywordize-keys true)]
      (apply f this c))))

(defn ^:export createRenderer
  "Given a DOM element, initialize a renderer on it, also returns an object which
  can have methods invoked on it to do stuff with it"
  [elem]
  (let [r (PlasioRenderer. (atom {}))]
    (startup r elem)
    (clj->js {:addCamera (partial-js add-camera r)
              :setClearColor (partial-js set-clear-color r)
              :setEyePosition (partial-js set-eye-position r)
              :setTargetPosition (partial-js set-target-position r)
              :addScaleObject (partial-js add-scale-object r)
              :removeAllScaleObjects (partial-js remove-all-scale-objects r)
              :addPointBuffer (partial-js add-point-buffer r)
              :removePointBuffer (partial-js remove-point-buffer r)})))
