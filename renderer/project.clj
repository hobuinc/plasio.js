(defproject renderer "0.1.0-SNAPSHOT"
  :description "State transactional 3D renderer for plasio.js"
  :url "http://github.com/verma/plasio.js"

  :dependencies [[org.clojure/clojure "1.7.0"]
                 [org.clojure/clojurescript "1.7.28"]
                 [org.clojure/core.async "0.1.346.0-17112a-alpha"]
                 [cljs-uuid "0.0.4"]
                 [rm-hull/cljs-webgl "0.1.5-SNAPSHOT"]
                 [weasel "0.3.0"]
                 [cljsjs/gl-matrix "2.3.0-jenanwise-0"]]

  :plugins [[lein-cljsbuild "1.0.6"]
            [lein-doo "0.1.5-SNAPSHOT"]]
  :profiles {:dev {:dependencies [[com.cemerick/piggieback "0.1.3"]]
                   :repl-options {:nrepl-middleware [cemerick.piggieback/wrap-cljs-repl]}
                   :plugins      [[com.cemerick/austin "0.1.5"]
                                  ]}}

  :source-paths ["src"]

  :cljsbuild {
              :builds [{:id "dev"
                        :source-paths ["src"]
                        :compiler {:output-to "target/dev/renderer.js"
                                   :main renderer.core
                                   :asset-path "renderer/target/dev"
                                   :output-dir "target/dev"
                                   :pretty-print true
                                   :optimizations :none}}
                       {:id "test"
                        :source-paths ["src" "test"]
                        :compiler {:output-to "target/test/testable.js"
                                   :output-dir "target/test"
                                   :main renderer.test-runner
                                   :pretty-print true
                                   :target :nodejs
                                   :optimizations :none}}

                       {:id "release"
                        :source-paths ["src"]
                        :compiler {:output-to "target/rel/renderer.js"
                                   :output-dir "target/rel"
                                   :externs ["externs/webgl.js"]
                                   :pretty-print false
                                   :optimizations :advanced}}]})
