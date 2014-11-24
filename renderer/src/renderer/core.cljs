(ns renderer.core
  (:require [clojure.set :as set]
            [cljs-uuid.core :as uuid]
            [renderer.engine :as r]
            [renderer.engine.util :as u]
            [renderer.log :as l])
  (:require-macros [cljs.core.async.macros :refer [go]]))

(def init-state {:render-target nil
                 :cameras []
                 :display {:clear-color [0 0 0]
                           :render-options {}}
                 :scale-objects []
                 :data {:batches []}})

(defn- do-startup [state]
  ;; Add the default camera to our renderer
  ;;
  (-> state
      (update-in [:cameras] conj {:active true
                                  :type "perspective"
                                  :fov 70})))

(defprotocol IPlasioRenderer
  (startup [this elem])
  (set-clear-color [this col] [this r g b])
  (add-camera [this props])
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
  (set-render-options [this opts]))

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

  (add-prop-listener [this korks f]
    (let [id (str (uuid/make-random))
          korks (map keyword (u/safe-korks korks))]
      ; make sure the current value is sent on subscribe
      (go (f (clj->js (get-in @state korks))))
      (add-watch state id
                 (fn [_ _ _ new-state]
                   (let [v (get-in new-state korks)]
                     (go (f (clj->js v))))))
      id))

  (remove-prop-listener [this id]
    (remove-watch state id))

  (add-point-buffer [this id]
    ;; TODO: make sure that passed buffer is of javascript array buffer
    (swap! state update-in [:point-buffers] conj id))

  (remove-point-buffer [this id]
    (swap! state update-in [:point-buffers]
           (fn [bufs]
             (remove #{id} bufs))))

  (add-loader [this loader]
    (swap! state update-in [:loaders] assoc (.-key loader) loader))

  (remove-loader [this name]
    (swap! state update-in [:loaders] dissoc name))

  (set-render-options [this opts]
    (swap! state update-in [:display :render-options] merge opts)))

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
              :addPropertyListener (partial-js add-prop-listener r)
              :removePropertyListener (partial-js remove-prop-listener r)
              :addPointBuffer (partial-js add-point-buffer r)
              :removePointBuffer (partial-js remove-point-buffer r)
              :addLoader (partial-js add-loader r)
              :setRenderOptions (partial-js set-render-options r)})))
