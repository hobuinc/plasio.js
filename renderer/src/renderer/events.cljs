(ns renderer.events)

(def ^:private raf
  (or ()))

(def raf
  (or (.-requestAnimationFrame js/window)
      (.-webkitRequestAnimationFrame js/window)
      (.-mozRequestAnimationFrame js/widnow)
      (.-msRequestAnimationFrame js/window)
      (fn [f]
        (.setTimeout js/window
                     #(f (.getTime (js/Date.)))
                     10))))

(def caf
  (or (.-cancelAnimationFrame js/window)
      (.-webkitCancelAnimationFrame js/window)
      (.-mozCancelAnimationFrame js/widnow)
      (.-msCancelAnimationFrame js/window)
      (fn [id]
        (.cancelTimeout js/window id))))

(defn next-tick [f & args]
  (raf
   (fn [ts]
     (apply f args))))

(defn cancel-next-tick [id]
  (caf id))

