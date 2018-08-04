(defproject renderer "0.1.0-SNAPSHOT"
  :description "State transactional 3D renderer for plasio.js"
  :url "http://github.com/verma/plasio.js"

  :dependencies [[org.clojure/clojure "1.8.0"]
                 [org.clojure/clojurescript "1.9.293"]
                 [org.clojure/core.async "0.2.395"]
                 [rm-hull/cljs-webgl "0.1.5-SNAPSHOT"]
                 [cljsjs/gl-matrix "2.3.0-jenanwise-0"]]

  :plugins [[lein-cljsbuild "1.1.5"]
            [lein-doo "0.1.7"]]

  :source-paths ["src"]

  :cljsbuild {
              :builds [{:id "dev"
                        :source-paths ["src"]
                        :compiler {:output-to "target/dev/renderer.js"
                                   :main renderer.core
                                   :asset-path "renderer/target/dev"
                                   :libs ["src/libs"]
                                   :output-dir "target/dev"
                                   :pretty-print true
                                   :optimizations :whitespace}}
                       {:id "test"
                        :source-paths ["src" "test"]
                        :compiler {:output-to "target/test/testable.js"
                                   :output-dir "target/test"
                                   :main renderer.test-runner
                                   :libs ["src/libs"]
                                   :pretty-print true
                                   :target :nodejs
                                   :optimizations :none}}

                       {:id "release"
                        :source-paths ["src"]
                        :compiler {:output-to "target/rel/renderer.cljs.js"
                                   :output-dir "target/rel"
                                   :libs ["src/libs"]
                                   :externs ["externs/webgl.js"]
                                   :pretty-print false
                                   :optimizations :advanced}}]})
