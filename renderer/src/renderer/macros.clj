(ns renderer.macros)

(defmacro with-profile [name & body]
  `(let [n# ~name]
     (js/console.time n#)
     ~@body
     (js/console.timeEnd n#)))
