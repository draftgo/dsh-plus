package cn.draftgo.dshplus.link

import android.view.View
import android.webkit.WebView
import android.widget.TextView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.util.IdentityHashMap

/** This channel only returns to the local device list; it never exposes LinkNative. */
internal class NativeDeviceNavigation(
    private val deviceButton: TextView,
    private val currentView: () -> WebView,
    private val returnToDevices: () -> Unit,
) {
    private data class Page(val origin: String, var name: String, val messages: Boolean, val state: PageDeviceNavigation = PageDeviceNavigation())
    private val pages = IdentityHashMap<WebView, Page>()

    fun attach(view: WebView, origin: String, name: String) {
        if (pages.containsKey(view)) return
        val messages = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        pages[view] = Page(origin, name, messages)
        if (!messages) return
        WebViewCompat.addWebMessageListener(view, "XiaojiaoDevices", setOf(origin)) { sourceView, message, sourceOrigin, mainFrame, _ ->
            val page = pages[sourceView] ?: return@addWebMessageListener
            if (sourceView !== currentView() || !deviceNavigationSourceAllowed(page.origin, sourceOrigin.toString(), sourceView.url.orEmpty(), mainFrame)) return@addWebMessageListener
            val raw = message.data.orEmpty()
            if (raw.length > 1024) return@addWebMessageListener
            val type = runCatching { JSONObject(raw).optString("type") }.getOrNull() ?: return@addWebMessageListener
            if (!page.state.accept(type)) return@addWebMessageListener
            if (type == "dsh-devices:show") returnToDevices() else update(sourceView)
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT))
            WebViewCompat.addDocumentStartJavaScript(view, script(pages.getValue(view)), setOf(origin))
    }

    private fun script(page: Page): String {
        val data = JSONObject().put("name", page.name).toString()
        val origin = JSONObject.quote(page.origin)
        return """
            (() => {
              if (window !== window.top || location.origin !== $origin || !location.pathname.startsWith('/link/workbench/') || !globalThis.XiaojiaoDevices?.postMessage) return;
              globalThis.__DSH_DEVICE_NAVIGATION__ = $data;
              globalThis.dispatchEvent(new CustomEvent('dsh-devices:navigation'));
            })();
        """.trimIndent()
    }

    fun show(view: WebView, name: String? = null) {
        pages[view]?.let { page ->
            if (name != null) page.name = name
            page.state.recheck()
        }
        update(view)
        pageReady(view)
    }

    fun pageStarted(view: WebView) { pages[view]?.state?.start(); update(view) }
    fun pageFailed(view: WebView) { pages[view]?.state?.fail(); update(view) }
    fun pageReady(view: WebView) {
        val page = pages[view] ?: return
        if (!page.messages || page.state.failed || !deviceNavigationSourceAllowed(page.origin, page.origin, view.url.orEmpty(), true)) return
        view.evaluateJavascript(script(page), null)
    }
    private fun update(view: WebView) {
        if (view !== currentView()) return
        val page = pages[view]
        deviceButton.visibility = if (page != null && !page.state.ready) View.VISIBLE else View.GONE
    }
    fun detach(view: WebView) {
        val page = pages.remove(view) ?: return
        if (page.messages) WebViewCompat.removeWebMessageListener(view, "XiaojiaoDevices")
    }
    fun close() { pages.keys.toList().forEach(::detach) }
}
