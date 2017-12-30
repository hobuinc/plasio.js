(ns renderer.macros)

(defmacro with-profile [name & body]
  `(let [n# ~name]
     (js/console.time n#)
     ~@body
     (js/console.timeEnd n#)))


(defmacro object-for
  "Iterates over each key-value pair in the given object calling the expression expr for
   each pair binding key and value to the current pair (similar to areduce)"
  [obj key value expr]
  `(let [all-keys# (goog.object/getKeys ~obj)
         len# (alength all-keys#)]
     (loop [idx# 0]
       (when (< idx# len#)
         (let [~key (aget all-keys# idx#)
               ~value (goog.object/get ~obj ~key)]
           ~expr
           (recur (unchecked-inc-int idx#)))))))

(defmacro array-for-each
  "Iterates over each item in an array, binding an index and element for each iteration"
  [arr index item & body]
  `(let [a# ~arr
         al# (alength a#)]
     (loop [i# 0]
       (when (< i# al#)
         (let [~index i#
               ~item (aget a# i#)]
           (do ~@body)
           (recur (unchecked-inc-int i#)))))))
