(ns renderer.stats-test
  (:require [cljs.test :refer-macros [deftest is]]
            [renderer.stats :as s]))

(def stats1 {-20 50 -10 22 0 55 10 22 20 55})
(def stats2 {-20 45 -10 2 0 5 10 2 20 5})
(def stats3 {-20 500 -10 22 0 155 10 202 20 155})

(def zero {-20 0 -10 0 0 0 10 0 20 0})
(def stats1+2 {-20 95 -10 24 0 60 10 24 20 60})
(def stats1+2+3 {-20 595 -10 46 0 215 10 226 20 215})

(deftest empty-stats-works
  (let [stats (s/make-stats)]
    (is (s/empty-stats? stats))
    (is (s/empty-stats? (s/remove-node! (s/add-node! stats 1 stats1) 1)))))


(deftest add-stats-works
  (let [stats (s/make-stats)]
    (is (= nil (s/current-stats stats)))
    (s/add-node! stats 1 stats1)
    (is (= stats1 (s/current-stats stats)))
    (s/remove-node! stats 1)
    (is (= zero (s/current-stats stats)))))


(deftest remove-unknown-works
  (let [stats (s/make-stats)]
    (s/add-node! stats "s1" stats1)
    (s/remove-node! stats "s2")
    (is (= stats1 (s/current-stats stats)))))

(deftest multiples-work
  (let [stats (s/make-stats)]
    (s/add-node! stats 1 stats1)
    (s/add-node! stats 2 stats2)
    (s/add-node! stats 3 stats3)
    (is (= stats1+2+3 (s/current-stats stats)))
    (s/remove-node! stats 3)
    (is (= stats1+2 (s/current-stats stats)))))

(deftest listen-invokes-f
  (let [stats (s/make-stats)
        invoked-with (atom :something-not-nil)]
    (s/listen! stats "stuff" (fn [_ val]
                               (reset! invoked-with val)))
    (is (nil? @invoked-with))))

(deftest listen-invokes-with-correct
  (let [stats (s/add-node! (s/make-stats) 1 stats1)
        invoked-with (atom :something-not-nil)]
    (s/listen! stats "stuff" (fn [_ val]
                               (reset! invoked-with val)))
    (is (= @invoked-with stats1))))

