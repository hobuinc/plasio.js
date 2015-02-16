(ns renderer.engine.util
  "Utility functions for everyone")


(defn mk-vector
  "Creates a vector depending on number of arguments provided"
  ([x y] (js/THREE.Vector2. x y))
  ([x y z] (js/THREE.Vector3. x y z))
  ([x y z w] (js/THREE.Vector4. x y z w)))

(defn set-vector
  "Updates the vector depending on the number of arguments provided"
  ([v [x y z]] (.set v x y z))
  ([v x y] (.set v x y))
  ([v x y z] (.set v x y z))
  ([v x y z w] (.set v x y z w)))

(defn mk-color
  ([col]
   (apply mk-color (take 3 col)))
  ([r g b]
   (js/THREE.Color. r g b)))

(defn tvstr [o]
  (str "(" (.-x o) ", " (.-y o) ", " (.-z o) ")"))

(defn safe-korks [a]
  (if (nil? a)
    []
    (if (sequential? a) a [a])))

(defn- join-ks [a b]
  (let [a (safe-korks a)
        b (safe-korks b)]
    (concat a b)))

(defn get-set
  "Gets and sets up the value for give js object"
  [obj korks f]
  (let [korks (safe-korks korks)
        ks1 (butlast korks)
        k   (-> korks last name)
        obj (reduce #(aget %1 (name %2)) obj ks1)
        nv  (if (ifn? f) (f (aget obj k)) f)]
    (aset obj k nv)))


(defn- map-vals
  "Map values for the given map using f"
  [f m]
  (into {} (for [[k v] m]
             [k (f [k v])])))
