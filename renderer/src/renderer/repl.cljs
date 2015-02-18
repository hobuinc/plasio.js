(ns renderer.repl
  "Some useful stuff when dealing with REPLs"
  (:require [renderer.core :refer [PlasioRenderer startup]]))

(defn make-dummy-point-buffer [s]
  (let [total-points (* s s)
        arr (js/Float32Array. (* 8 total-points))
        wp  (fn [off x z]
              (doall (map (fn [i v] (aset arr (+ off i) v))
                          (range 8)
                          [x 0 z 1 1 1 0 0])))]
    (doall (map #(wp (* 8 %) (rem % s) (quot % s)) (range total-points)))
    arr))


(defn setup-repl-env []
  (let [div     (.createElement js/document "div")
        script  (.createElement js/document "script")]
    (.setAttribute div "style"  "width:800px;height:600px")
    (.setAttribute script "src" "http://cdnjs.cloudflare.com/ajax/libs/three.js/r68/three.js")
    (.appendChild js/document.body div)
    (.appendChild js/document.body script)
    (let [r (PlasioRenderer. (atom {}) (atom nil))]
      (startup r div)
      r)))

