(ns renderer.time-travel
  "A time traveling mechanism")

(defprotocol ITimeMachine
  (push! [this snapshot])
  (activate-snapshot! [this index])
  (snapshot-count [this]))

(defrecord TimeMachine [state history-size]
  ITimeMachine
  (push! [this snapshot]
    (swap! state
           (fn [{:keys [snapshots active-index]} snapshots]
             ;; if we try to push snapshot onto time machine the time sets to
             ;; where we were last
             (let [total (count snapshots)
                   ;; active index is negative, indicating how far back we want to go
                   ;; we drop as many elements
                   current-snapshots (drop (- active-index) snapshots)
                   current-snapshots (if (> (count current-snapshots) history-size)
                                       (drop-last current-snapshots)
                                       current-snapshots)]
               {:snapshots (conj current-snapshots snapshots)
                :active-index 0}))))

  (activate-snapshot! [this index]
    {:pre [(neg? index)]}
    (swap! state assoc :active-index index)
    (->> @state
         :snapshots
         (drop (- index))
         first))

  
  (snapshot-count [this]
    (-> @state
        :snapshots
        count)))

(defn make-time-machine [history-size]
  (TimeMachine. (atom nil) history-size))
