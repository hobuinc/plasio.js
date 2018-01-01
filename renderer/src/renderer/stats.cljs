(ns renderer.stats
  (:require [goog.object :as gobject])
  (:require-macros [renderer.macros :refer [js-map-foreach object-for]]))

(defprotocol IStats
  (add-node! [this id node])
  (remove-node! [this id])
  (current-stats [this])
  (listen! [this key f])
  (unlisten! [this key])
  (range [this])
  (empty-stats? [this]))


(defn merge-stats
  "Given a current accumulated states, and a new stats update to be added this function
   updates the stats in place onto stats"
  [stats node]
  (js-map-foreach node key value
                  (.set stats key
                        (if (.has stats key)
                          (+ (.get stats key) value)
                          value))))

(defn unmerge-stats
  "Same as merge stats, but subtracts instead of adding"
  [stats node]
  (js-map-foreach node key value
                  (when (.has stats key)
                    (.set stats key (- (.get stats key) value)))))

(def ^:private ^:mutable nn)
(def ^:private ^:mutable xx)

(defn update-min-max
  "Given a JS object to store min and max for given stats and a stats map, update the min max values"
  [minmax stats]
  (set! nn (gobject/get minmax "min"))
  (set! xx (gobject/get minmax "max"))
  (js-map-foreach stats key value
                  (when (< key nn) (set! nn key))
                  (when (> key xx) (set! xx key)))
  (gobject/set minmax "min" nn)
  (gobject/set minmax "max" xx))

(defrecord TransientStats [stats nodes listeners minmax]
  IStats
  (add-node! [this id node]
    (.set nodes id node)
    (merge-stats stats node)
    (update-min-max minmax stats)
    (doseq [[_ f] @listeners]
      (f stats minmax))
    this)

  (remove-node! [this id]
    (when-let [data (.get nodes id)]
      (.delete nodes id)
      (unmerge-stats stats data)
      (update-min-max minmax stats)
      (doseq [[_ f] @listeners]
        (f stats minmax)))
    this)

  (current-stats [_]
    stats)

  (listen! [_ id f]
    (swap! listeners assoc id f)
    ;; invoke on add
    (f stats minmax))

  (unlisten! [_ id]
    (swap! listeners dissoc id))

  (empty-stats? [_]
    (zero? (.-size stats)))

  (range [_]
    [(gobject/get minmax "min")
     (gobject/get minmax "max")]))

(defn make-stats []
  (TransientStats. (js/Map.) (js/Map.) (atom {}) (js-obj "min" js/Number.MAX_SAFE_INTEGER
                                                         "max" js/Number.MIN_SAFE_INTEGER)))
