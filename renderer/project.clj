(defproject renderer "0.1.0-SNAPSHOT"
  :description "State transactional 3D renderer for plasio.js"
  :url "http://github.com/verma/plasio.js"

  :dependencies [[org.clojure/clojure "1.6.0"]
                 [org.clojure/clojurescript "0.0-2311"]
                 [org.clojure/core.async "0.1.346.0-17112a-alpha"]
                 [cljs-uuid "0.0.4"]
                 [rm-hull/cljs-webgl "0.1.5-SNAPSHOT"]
                 [weasel "0.3.0"]]

  :plugins [[lein-cljsbuild "1.0.4-SNAPSHOT"]]
  :profiles {:dev {:dependencies [[com.cemerick/piggieback "0.1.3"]]
                   :repl-options {:nrepl-middleware [cemerick.piggieback/wrap-cljs-repl]}
                   :plugins [[com.cemerick/austin "0.1.5"]]}}

  :source-paths ["src"]

  :cljsbuild {
    :builds [{:id "dev"
              :notify-command ["./scripts/post-compile.sh" "target/dev"]
              :source-paths ["src"]
              :compiler {:output-to "target/dev/renderer.js"
                         :output-dir "target/dev"
                         :externs ["vendor/gl-matrix.js"]
                         :pretty-print true
                         :optimizations :whitespace}}
             {:id "release"
              :notify-command ["./scripts/post-compile.sh" "target/rel"]
              :source-paths ["src"]
              :compiler {
                         :output-to "target/rel/renderer.js"
                         :output-dir "target/rel"
                         :externs ["vendor/gl-matrix.js" "externs/webgl.js"]
                         :pretty-print false
                         :optimizations :advanced}}]})
