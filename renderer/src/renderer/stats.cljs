(ns renderer.stats)

(defprotocol IStats
  (add-node! [this id node])
  (remove-node! [this id])
  (current-stats [this])
  (listen! [this key f])
  (unlisten! [this key])
  (empty-stats? [this]))


(defrecord TransientStats [state]
  IStats
  (add-node! [this id node]
    (swap! state
           (fn [st]
             (-> st
                 (update :stats #(merge-with + % node))
                 (update :nodes assoc id node))))
    this)

  (remove-node! [this id]
    (when-let [data (get-in @state [:nodes id])]
      (swap! state
             (fn [st]
               (-> st
                   (update :stats #(merge-with - % data))
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
    (let [stats (:stats @state)]
      (or (nil? stats)
          (not (some (comp pos? second) stats))))))

(defn make-stats []
  (TransientStats. (atom {})))
