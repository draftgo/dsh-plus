package cn.draftgo.dshplus.link

import java.net.URI
import kotlin.math.max
import kotlin.math.pow

/** Rendered page colors, independent of Android resources and theme preferences. */
internal data class PageAppearance(val background: Int, val foreground: Int) {
    val darkSystemIcons: Boolean get() = luminance(background) > 0.179
    companion object {
        fun parse(background: String, foreground: String): PageAppearance? {
            fun color(value: String): Int? = if (value.matches(Regex("#[0-9a-fA-F]{6}")))
                (0xff000000L or value.substring(1).toLong(16)).toInt() else null
            return PageAppearance(color(background) ?: return null, color(foreground) ?: return null)
        }
        private fun luminance(color: Int): Double {
            fun channel(shift: Int): Double {
                val value = ((color ushr shift) and 255) / 255.0
                return if (value <= 0.04045) value / 12.92 else ((value + 0.055) / 1.055).pow(2.4)
            }
            return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
        }
    }
}

internal fun appearanceSourceAllowed(expectedOrigin: String, sourceOrigin: String, pageUrl: String, isMainFrame: Boolean): Boolean {
    if (!isMainFrame) return false
    return runCatching {
        val expected = URI(expectedOrigin); val source = URI(sourceOrigin); val page = URI(pageUrl)
        fun sameOrigin(value: URI) = value.scheme == expected.scheme && value.host.equals(expected.host, true) &&
            (if (value.port == -1) 443 else value.port) == (if (expected.port == -1) 443 else expected.port) && value.rawUserInfo == null
        sameOrigin(source) && sameOrigin(page) && page.scheme == "https" &&
            if (expectedOrigin == "https://appassets.androidplatform.net") page.path == "/assets/index.html"
            else page.path.startsWith("/link/workbench/")
    }.getOrDefault(false)
}

/** One native safe-area owner: bars/cutout/IME overlap rather than accumulate. */
internal data class ContentInsets(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    fun merge(other: ContentInsets) = ContentInsets(max(left, other.left), max(top, other.top), max(right, other.right), max(bottom, other.bottom))
}
