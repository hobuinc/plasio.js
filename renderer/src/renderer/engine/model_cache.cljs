(ns renderer.engine.model-cache
  "Manages model cache"
  (:require [cljs.core.async :refer [<!] :as async])
  (:require-macros [cljs.core.async.macros :refer [go]]))

(defprotocol IModelCache
  "The protocol which defines the iterface to the caching strategy for models"
  (get-model [this uri])
  (clear [this]))

(defn- load-model [uri]
  (let [c (async/chan)
        m (async/mult c)
        loader (js/THREE.BinaryLoader.)]
    (.load loader uri
           (fn [geom mats]
             (async/onto-chan c [[geom mats]])))
    m))


(defrecord ModelCache [state]
  IModelCache
  (get-model [this uri]
    (let [ds (get @state uri)]
      (println "Model cache" ds)
      (cond
        (sequential? ds) (async/to-chan [ds])
        (nil? ds) (let [m (load-model uri)
                        c1 (async/chan)
                        c2 (async/chan)]
                    (async/tap m c1)
                    (async/tap m c2)
                    (go (let [v (<! c1)]
                          (println "Model was loaded!" v)
                          (swap! state assoc uri v)))
                    (swap! state assoc uri m)
                    c2)
        :else (let [c (async/chan)]
                (async/tap ds c)
                c))))

  (clear [this]
    (reset! state {})))

(defn make-cache []
  (map->ModelCache {:state (atom {})}))

