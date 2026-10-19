package cn.draftgo.dshplus.link

import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.util.IdentityHashMap

/** Only colors cross this origin-limited channel; remote pages have no LinkNative. */
internal class NativeAppearance(
    private val activity: AppCompatActivity,
    private val root: View,
    private val deviceButton: TextView,
    private val currentView: () -> WebView,
) {
    private data class Page(val origin: String, var appearance: PageAppearance? = null, val messages: Boolean)
    private val pages = IdentityHashMap<WebView, Page>()
    private val script = activity.assets.open("native-appearance.js").bufferedReader().use { it.readText() }
    private val handler = Handler(Looper.getMainLooper())
    private var resumed = false
    private val poll = object : Runnable {
        override fun run() {
            if (!resumed) return
            val view = currentView()
            if (pages[view]?.messages == false) refresh(view)
            handler.postDelayed(this, 750)
        }
    }

    fun attach(view: WebView, origin: String) {
        if (pages.containsKey(view)) return
        val messages = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        pages[view] = Page(origin, messages = messages)
        if (messages) WebViewCompat.addWebMessageListener(view, "XiaojiaoAppearance", setOf(origin)) { sourceView, message, sourceOrigin, mainFrame, _ ->
            val page = pages[sourceView] ?: return@addWebMessageListener
            if (appearanceSourceAllowed(page.origin, sourceOrigin.toString(), sourceView.url.orEmpty(), mainFrame)) accept(sourceView, message.data.orEmpty())
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) WebViewCompat.addDocumentStartJavaScript(view, script, setOf(origin))
    }

    fun pageReady(view: WebView) {
        val page = pages[view] ?: return
        if (!appearanceSourceAllowed(page.origin, page.origin, view.url.orEmpty(), true)) return
        view.evaluateJavascript(script + "\nwindow.__xiaojiaoAppearance?.read() ?? null") { raw -> accept(view, raw) }
    }

    fun show(view: WebView) {
        pages[view]?.appearance?.let(::apply)
        refresh(view)
        handler.removeCallbacks(poll)
        if (resumed && pages[view]?.messages == false) handler.post(poll)
    }

    private fun refresh(view: WebView) {
        val page = pages[view] ?: return
        if (!appearanceSourceAllowed(page.origin, page.origin, view.url.orEmpty(), true)) return
        view.evaluateJavascript("window.__xiaojiaoAppearance?.read() ?? null") { raw -> accept(view, raw) }
    }

    private fun accept(view: WebView, raw: String) {
        if (raw.length > 4096) return
        val page = pages[view] ?: return
        val value = runCatching { JSONObject(raw) }.getOrNull() ?: return
        if (value.optString("href") != view.url) return
        if (!appearanceSourceAllowed(page.origin, page.origin, value.optString("href"), true) ||
            !appearanceSourceAllowed(page.origin, page.origin, view.url.orEmpty(), true)) return
        val appearance = PageAppearance.parse(value.optString("background"), value.optString("foreground")) ?: return
        page.appearance = appearance
        if (view === currentView()) apply(appearance)
    }

    @Suppress("DEPRECATION")
    private fun apply(appearance: PageAppearance) {
        root.setBackgroundColor(appearance.background)
        deviceButton.setBackgroundColor(appearance.background)
        deviceButton.setTextColor(appearance.foreground)
        currentView().setBackgroundColor(appearance.background)
        activity.window.apply {
            statusBarColor = Color.TRANSPARENT
            navigationBarColor = Color.TRANSPARENT
            if (Build.VERSION.SDK_INT >= 28) navigationBarDividerColor = Color.TRANSPARENT
            if (Build.VERSION.SDK_INT >= 29) { isStatusBarContrastEnforced = false; isNavigationBarContrastEnforced = false }
        }
        WindowCompat.getInsetsController(activity.window, root).apply {
            isAppearanceLightStatusBars = appearance.darkSystemIcons
            isAppearanceLightNavigationBars = appearance.darkSystemIcons
        }
    }

    fun resume() { resumed = true; show(currentView()) }
    fun pause() { resumed = false; handler.removeCallbacks(poll) }
    fun detach(view: WebView) {
        val page = pages.remove(view) ?: return
        if (page.messages) WebViewCompat.removeWebMessageListener(view, "XiaojiaoAppearance")
    }
    fun close() { pause(); pages.keys.toList().forEach(::detach) }
}
