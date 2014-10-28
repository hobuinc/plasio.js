(ns renderer.log
  "Logging module controllable by vars")

(enable-console-print!)

(def ^:dynamic *show-log-messages* false)

(def ^:private log-levels {:info "INFO"
                           :warn "WARN"
                           :error "ERROR"})

(defn- log [kind & args]
  (when *show-log-messages*
    (apply println (kind log-levels) args)))

(def logi (partial log :info))
(def logw (partial log :warn))
(def loge (partial log :error))
