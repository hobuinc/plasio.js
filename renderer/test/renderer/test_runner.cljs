(ns renderer.test-runner
  (:require [cljs.test :as test]
            [doo.runner :refer-macros [doo-all-tests doo-tests]]
            [renderer.stats-test]))


(doo-tests 'renderer.stats-test)
