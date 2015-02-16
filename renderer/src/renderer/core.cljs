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

(def init-state {:cameras []
                 :display {:clear-color [0 0 0]
                           :render-options {}}})

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
  (set-render-options [this opts])
  (pick-point [this x y])
  (apply-state [this state])
  (resize-view! [this w h]))

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

  (pick-point [this x y]
    (r/pick-point @render-engine x y))

  (apply-state [this st]
    (reset! state st))

  (resize-view! [this w h]
    (r/resize-view! @render-engine w h)))


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
              :applyState (partial-js apply-state r)
              :setRenderViewSize (partial-js resize-view! r)}))) 
