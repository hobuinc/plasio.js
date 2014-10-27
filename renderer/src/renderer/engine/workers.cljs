(ns renderer.engine.workers
  "Web workers for loading stuff"
  (:require
    [renderer.log :as l]
    [cljs.core.async :refer [chan close! timeout put!]]
    [servant.core :as servant]
    [servant.worker :as worker])
  (:require-macros [cljs.core.async.macros :as m :refer [go]]
                   [servant.macros :refer [defservantfn]]))

(def servants-state (atom nil))

(defn- do-main-startup
  "Non web-worker load startup"
  []
  (reset! servants-state
          {:servant-chan (servant/spawn-servants 1 "renderer/plasio-renderer.js")}))

(defn- do-ww-startup
  "Webworker startup"
  []
  (worker/bootstrap))

; Make sure the servant code is triggered right
(if (servant/webworker?)
  (do-ww-startup)
  (do-main-startup))

(defn- make-attrs
  "Given a geometry buffer, adds attributes and returns an arr ay of arraybuffers"
  [total-points]
  (let [attrs {:position 3 :color 3 :intensity 1 :classification 1}]
    (into {} (for [[k s] attrs]
               [k {:array (js/Float32Array. (* s total-points)) :size s}]))))


(defn- cp-elements [dest woff src roff len]
  (loop [i 0]
    (when (< i len)
      (aset dest (+ woff i) (aget src (+ roff i)))
      (recur (inc i)))))


(defservantfn ab->attrs
  "Makes a particle system out of given seq of points"
  [ab]
  (let [points (js/Float32Array. ab)
        total-points (quot (.-length points) 8)
        attrs (make-attrs total-points)
        attrs-array (mapv #(.-buffer (:array %)) (vals attrs))
        position (get-in attrs [:position :array])
        color (get-in attrs [:color :array])
        intensity (get-in attrs [:intensity :array])
        klass (get-in attrs [:classification :array])]
    ;; Add all the points in
    (loop [pcount 0 rindex 0]
      (if (< pcount total-points)
        (let [woff (* 3 pcount)]
          ;; copy points
          (cp-elements position woff points rindex 3)
          (cp-elements color woff points (+ 3 rindex) 3)
          (cp-elements intensity pcount points (+ 6 rindex) 1)
          (cp-elements klass pcount points (+ 7 rindex) 1)
          (recur (inc pcount) (+ rindex 8)))
        [(clj->js attrs) attrs-array]))))


(defn array-buffer->attrs
  "Takes an array buffer, does the correct context switch on it, and then returns a geom
  object with correct array buffer contexts (relying a little bit on the internal structure of
  a THREE js buffer geometry object since we need to context switch the returned buffers"
  [ab]
  (go (let [servant-chan (@servants-state :servant-chan)
            as-ab (if (= (type ab) js/Float32Array) (.-buffer ab) ab)
            c (servant/servant-thread servant-chan
                                      servant/array-buffer-message
                                      ab->attrs
                                      [as-ab] [as-ab])
            r (js->clj (<! c) :keywordize-keys true)]
        ; turn all plain arrays in float32
        (mapv (fn [[k v]]
                [k (update-in v [:array] #(js/Float32Array. %))]) r))))



