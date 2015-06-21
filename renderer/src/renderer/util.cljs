(ns renderer.util
  "Utility stuff"
  (:require [renderer.events :refer [next-tick]]
            [goog.crypt.base64 :as b64]))

(defrecord DirtyAtom [state ff]
  IDeref
  (-deref [_] (::value @state)))

(defn dirty-swap! [a f & args]
  (swap! (:state a) update-in [::value] #(apply f % args))
  (when-not (::dirty? (:state a))
    (swap! (:state a) assoc ::dirty? true)
    (next-tick
     #(do
        ((:ff a) (::value @(:state a)))
        (clojure.core/swap! (:state a) assoc ::dirty? false)))))

(defn dirty-atom [val f]
  (DirtyAtom. (atom {::value val
                     ::dirty? false}) f))

(defn add-framed-watch [a key f]
  (let [state (atom {:dirty? false
                     :old nil
                     :new nil})]
    (add-watch a key
               (fn [_ _ ov nv]
                 ;; retain old state if we already have it
                 ;; while within a frame we don't care what all transitions we go through
                 ;; we only care and notify the transition from the first one to the last one

                 (let [old-state (or (:old @state)
                                     ov)
                       new-state nv]
                   (swap! state assoc
                          :old old-state
                          :new new-state)
                   (when-not (:dirty? @state)
                     (swap! state assoc :dirty? true)
                     (next-tick
                      (fn []
                        (f a key (:old @state) (:new @state))
                        (swap! state assoc
                               :dirty? false
                               :old nil
                               :new nil))))))))
  
  #_(let [state (atom {:dirty? false
                     :transitions []})]
    (add-watch a key
               (fn [_ _ ov nv]
                 (swap! state update-in :transitions conj [ov nv])
                 (when-not (:dirty? @state)
                   (swap! state assoc :dirty? true)
                   (next-tick
                    #(when-let [txs (-> @state
                                        :transitions
                                        seq)]
                       (doseq [[old current] txs]
                         (f a key old current))

                       ;; since we fired all transitions, we set ourselves clean
                       (swap! state assoc :dirty? false))))))))

(defn tap
  ([v]
   (tap v "tap"))
  ([v n]
   (println "----------------------------- " n " :: " v)
   v))

(defn encode-id
  "Encode the given ID and return a string representation of the JSON object"
  [jsobj]
  (b64/encodeString (js/JSON.stringify jsobj)))

(defn decode-id
  "Decode the given ID and return a json object"
  [s]
  (js/JSON.parse (b64/decodeString s)))
