package cn.draftgo.dshplus.link

import java.net.URI

/** A workbench can only expose return navigation from its paired main document. */
internal fun deviceNavigationSourceAllowed(expectedOrigin: String, sourceOrigin: String, pageUrl: String, isMainFrame: Boolean): Boolean {
    if (!appearanceSourceAllowed(expectedOrigin, sourceOrigin, pageUrl, isMainFrame)) return false
    return runCatching {
        val path = URI(pageUrl).path
        path.startsWith("/link/workbench/") && path.split('/').none { it == "." || it == ".." || it.contains(92.toChar()) || it.contains('%') }
    }.getOrDefault(false)
}

/** Readiness is document-scoped and must be renewed after navigation or cache switches. */
internal class PageDeviceNavigation {
    var ready = false
        private set
    var failed = false
        private set

    fun recheck() { ready = false }
    fun start() { ready = false; failed = false }
    fun fail() { ready = false; failed = true }
    fun accept(type: String): Boolean {
        if (failed) return false
        return when (type) {
            "dsh-devices:ready" -> { ready = true; true }
            "dsh-devices:unready" -> { ready = false; true }
            "dsh-devices:show" -> ready
            else -> false
        }
    }
}
