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
                     :current nil})]
    (add-watch a key
               (fn [_ _ ov nv]
                 (swap! state assoc
                        :old ov
                        :current nv)
                 (when-not (:dirty? @state)
                   (swap! state assoc :dirty? true)
                   (next-tick
                    #(let [{:keys [old current]} @state]
                       (f a key old current)
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
