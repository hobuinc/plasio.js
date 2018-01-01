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
  `(let [all-keys# (js/Object.keys ~obj)
         len# (alength all-keys#)]
     (loop [idx# 0]
       (when (< idx# len#)
         (let [~key (aget all-keys# idx#)
               ~value (goog.object/get ~obj ~key)]
           ~expr
           (recur (unchecked-inc-int idx#)))))))

(defmacro js-map-foreach
  "Iterates over each key-value pair in the given map, uses fast JS primitives to do so"
  [map-obj key value & body]
  `(let [map-obj# ~map-obj
         key-iter# (.keys map-obj#)]
     (loop []
       (let [v# (.next key-iter#)
             ^boolean done# (.-done v#)]

         (when-not done#
           (let [~key (.-value v#)
                 ~value (.get map-obj# ~key)]
             ~@body)
           (recur))))))

(defmacro array-for-each
  "Iterates over each item in an array, binding an index and element for each iteration"
  [arr index item & body]
  `(when-let [a# ~arr]
     (let [al# (alength a#)]
       (loop [i# 0]
         (when (< i# al#)
           (let [~index i#
                 ~item (aget a# i#)]
             (do ~@body)
             (recur (unchecked-inc-int i#))))))))
