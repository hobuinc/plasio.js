(ns renderer.stats
  (:require [renderer.jsutil :as jsutil]))

(defprotocol IStats
  (add-node! [this id node])
  (remove-node! [this id])
  (current-stats [this])
  (listen! [this key f])
  (unlisten! [this key])
  (empty-stats? [this])
  (equal-stats? [this other]))


(defrecord TransientStats [state]
  IStats
  (add-node! [this id node]
    (swap! state
           (fn [st]
             (-> st
                 (update :stats #(jsutil/fastMergeStatsNode % node))
                 (update :nodes assoc id node))))
    this)

  (remove-node! [this id]
    (when-let [node (get-in @state [:nodes id])]
      (swap! state
             (fn [st]
               (-> st
                   (update :stats #(jsutil/fastUnmergeStatsNode % node))
                   (update :nodes dissoc id)))))
    this)

  (current-stats [_]
    (:stats @state))

  (listen! [_ id f]
    (add-watch state id (fn [_ _ o n] (f (:stats o) (:stats n))))
    ;; invoke on add
    (f nil (:stats @state)))

  (unlisten! [_ id]
    (remove-watch state id))

  (empty-stats? [_]
    ;; stats are empty if they are empty or if all
    ;; stored values within them are zeros.
    (let [stats (:stats @state)]
      (or (nil? stats)
          (not (jsutil/jsMapHasNonZeroValue stats)))))

  (equal-stats? [_ other]
    ;; stats are equal if the two histograms they store are equal
    ;; and they have the same set of nodes
    (and (jsutil/jsMapsAreEqual (-> @state :stats)
                                (-> @(:state other) :stats))
         (= (set (-> @state :nodes keys))
            (set (-> @(:state other) :nodes keys))))))

(defn make-stats []
  (TransientStats. (atom {})))
