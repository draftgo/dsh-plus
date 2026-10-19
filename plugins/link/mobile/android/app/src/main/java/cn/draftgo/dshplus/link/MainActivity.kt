package cn.draftgo.dshplus.link

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors
import java.util.concurrent.ConcurrentHashMap

private const val APP_ORIGIN = "https://appassets.androidplatform.net"
private const val START_URL = "$APP_ORIGIN/assets/index.html"

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var localView: WebView
    private lateinit var layout: android.widget.LinearLayout
    private val workbenches = ConcurrentHashMap<String, WebView>()
    private lateinit var bridge: LinkBridge
    private var pendingBootstrap: String? = null
    private lateinit var devicesButton: android.widget.TextView
    private lateinit var appearance: NativeAppearance
    private var workbenchIdentity: Identity? = null
    private var microphoneRequest: android.webkit.PermissionRequest? = null
    private var uploadCallback: android.webkit.ValueCallback<Array<android.net.Uri>>? = null
    private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        microphoneRequest?.let { request -> if (granted && request.origin.toString().trimEnd('/') == workbenchIdentity?.url) request.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny() }
        microphoneRequest = null
    }
    private val uploadPicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        uploadCallback?.onReceiveValue(android.webkit.WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        uploadCallback = null
    }

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        if (result.contents != null) handlePairUri(result.contents)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        bridge = LinkBridge(this) { json ->
            pendingBootstrap = json
            dispatchBootstrap(json)
        }
        webView = WebView(this)
        localView = webView
        layout = android.widget.LinearLayout(this).apply { orientation = android.widget.LinearLayout.VERTICAL; setBackgroundColor(android.graphics.Color.rgb(34, 34, 34)) }
        val density = resources.displayMetrics.density
        devicesButton = android.widget.TextView(this).apply {
            text = "‹  设备"; textSize = 14f; setTextColor(android.graphics.Color.rgb(67, 91, 117))
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding((16 * density).toInt(), 0, (16 * density).toInt(), 0)
            contentDescription = "返回本机设备列表"; visibility = android.view.View.GONE
            setOnClickListener { returnToDevices() }
        }
        layout.addView(devicesButton, android.widget.LinearLayout.LayoutParams(-1, (44 * density).toInt()))
        layout.addView(webView, android.widget.LinearLayout.LayoutParams(-1, 0, 1f))
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(layout) { view, insets ->
            val bars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars() or androidx.core.view.WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())
            val padding = ContentInsets(bars.left, bars.top, bars.right, bars.bottom).merge(ContentInsets(ime.left, ime.top, ime.right, ime.bottom))
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom)
            // WebViews are already inside the native safe area. Do not send it twice.
            androidx.core.view.WindowInsetsCompat.CONSUMED
        }
        setContentView(layout)
        androidx.core.view.ViewCompat.requestApplyInsets(layout)
        appearance = NativeAppearance(this, layout, devicesButton) { webView }
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.settings.setSupportMultipleWindows(false)
        webView.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        android.webkit.CookieManager.getInstance().setAcceptCookie(true)
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        webView.webViewClient = localClient()
        webView.addJavascriptInterface(bridge, "LinkNative")
        appearance.attach(webView, APP_ORIGIN)
        webView.loadUrl(START_URL)
        intent?.data?.let { handlePairUri(it.toString()) }
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (workbenchIdentity != null) returnToDevices()
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.data?.let { handlePairUri(it.toString()) }
    }

    override fun onResume() {
        super.onResume()
        if (::appearance.isInitialized) appearance.resume()
    }

    override fun onPause() {
        if (::appearance.isInitialized) appearance.pause()
        super.onPause()
    }

    override fun onDestroy() {
        microphoneRequest?.deny(); uploadCallback?.onReceiveValue(null)
        bridge.close()
        appearance.close()
        localView.removeJavascriptInterface("LinkNative")
        workbenches.values.forEach { it.destroy() }; workbenches.clear()
        localView.destroy()
        super.onDestroy()
    }

    private fun localClient() = object : WebViewClient() {
        private val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this@MainActivity))
            .build()

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            return loader.shouldInterceptRequest(request.url)
                ?: WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), java.io.ByteArrayInputStream(ByteArray(0)))
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net") return false
            if (uri.scheme == "dshlink") { handlePairUri(uri.toString()); return true }
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
            return true
        }

        override fun onPageFinished(view: WebView, url: String) {
            appearance.pageReady(view)
            pendingBootstrap?.let { dispatchBootstrap(it) }
        }
    }

    private fun handlePairUri(raw: String) {
        val parsed = runCatching { parsePairingLink(raw) }.getOrElse {
            android.widget.Toast.makeText(this, it.message ?: "配对信息无效", android.widget.Toast.LENGTH_LONG).show()
            return
        }
        val value = JSONObject().apply {
            put("url", parsed.url); put("pin", parsed.pin); put("code", parsed.code)
            if (parsed.name.isNotEmpty()) put("name", parsed.name)
        }.toString()
        val saved = bridge.saveIdentity(value)
        val outcome = JSONObject(saved)
        if (!outcome.optBoolean("ok")) {
            android.widget.Toast.makeText(this, outcome.optString("error", "配对信息无效"), android.widget.Toast.LENGTH_LONG).show()
        }
    }

    private fun dispatchBootstrap(json: String) {
        if (!::webView.isInitialized) return
        webView.post {
            if (!webView.url.orEmpty().startsWith(START_URL)) return@post
            val encoded = JSONObject.quote(json)
            webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('link:bootstrap',{detail:$encoded}));", null)
        }
    }

    fun launchScanner() {
        runOnUiThread { scanner.launch(ScanOptions().apply {
            setCaptureActivity(LinkScannerActivity::class.java)
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt("")
            setBeepEnabled(false)
            setOrientationLocked(true)
        }) }
    }

    fun deliverResult(script: String) { if (localView.url.orEmpty().startsWith(START_URL)) localView.evaluateJavascript(script, null) }
    private fun showView(view: WebView) {
        if (webView === view) return
        layout.removeView(webView); webView = view
        layout.addView(view, android.widget.LinearLayout.LayoutParams(-1, 0, 1f))
        appearance.show(view)
    }
    fun canOpenDevice(id: String): Boolean = workbenches.containsKey(id) || workbenches.size < 4
    fun forgetDevice(id: String) {
        runOnUiThread { workbenches.remove(id)?.let { view -> if (view === webView) returnToDevices(); appearance.detach(view); view.destroy() } }
    }

    fun openWorkbench(identity: Identity, cookie: String, isCurrent: () -> Boolean) {
        runOnUiThread {
            if (!isCurrent()) return@runOnUiThread
            val cached = workbenches[identity.id]
            if (cached != null && cached.tag == identity.url) {
                android.webkit.CookieManager.getInstance().setCookie(identity.url + "/link/workbench/", cookie) { accepted ->
                    if (!isCurrent()) return@setCookie
                    if (accepted) {
                        showView(cached); workbenchIdentity = identity; pendingBootstrap = null
                        devicesButton.text = "‹  设备 · " + identity.publicJson().optString("name")
                        devicesButton.visibility = android.view.View.VISIBLE
                    } else workbenchFailed("无法保存工作台连接，请重试")
                }
                return@runOnUiThread
            }
            cached?.let { workbenches.remove(identity.id); appearance.detach(it); it.destroy() }
            val remote = WebView(this).apply {
                settings.javaScriptEnabled = true; settings.domStorageEnabled = true
                settings.allowFileAccess = false; settings.allowContentAccess = false
                settings.setSupportMultipleWindows(false)
                settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
                tag = identity.url
            }
            android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(remote, false)
            workbenches[identity.id] = remote
            appearance.attach(remote, identity.url)
            showView(remote)
            workbenchIdentity = identity
            devicesButton.text = "‹  设备 · " + identity.publicJson().optString("name")
            devicesButton.visibility = android.view.View.VISIBLE
            pendingBootstrap = null
            webView.removeJavascriptInterface("LinkNative")
            webView.webViewClient = workbenchClient(identity)
            webView.webChromeClient = object : android.webkit.WebChromeClient() {
                override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                    runOnUiThread {
                        if (request.origin.toString().trimEnd('/') != identity.url || !request.resources.contains(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE)) { request.deny(); return@runOnUiThread }
                        microphoneRequest?.deny(); microphoneRequest = request
                        microphonePermission.launch(android.Manifest.permission.RECORD_AUDIO)
                    }
                }
                override fun onPermissionRequestCanceled(request: android.webkit.PermissionRequest) { if (microphoneRequest === request) microphoneRequest = null }
                override fun onShowFileChooser(view: WebView, callback: android.webkit.ValueCallback<Array<android.net.Uri>>, params: FileChooserParams): Boolean {
                    uploadCallback?.onReceiveValue(null); uploadCallback = callback
                    return runCatching { uploadPicker.launch(params.createIntent()); true }.getOrElse { uploadCallback?.onReceiveValue(null); uploadCallback = null; false }
                }
            }
            android.webkit.CookieManager.getInstance().setCookie(identity.url + "/link/workbench/", cookie) { accepted ->
                if (!isCurrent()) return@setCookie
                if (accepted) {
                    val path = getSharedPreferences("link_locations", Context.MODE_PRIVATE).getString(identity.id, "/link/workbench/") ?: "/link/workbench/"
                    val restored = runCatching { URI(identity.url + path) }.getOrNull()
                    remote.loadUrl(if (restored != null && restored.host == URI(identity.url).host && restored.path.startsWith("/link/workbench/") && !path.startsWith("//")) identity.url + path else identity.url + "/link/workbench/")
                }
                else workbenchFailed("无法保存工作台连接，请重试")
            }
        }
    }

    private fun workbenchClient(identity: Identity) = object : WebViewClient() {
        private fun allowed(uri: android.net.Uri): Boolean = runCatching {
            val target = URI(uri.toString()); val host = URI(identity.url)
            target.scheme == "https" && target.host.equals(host.host, true) && target.port == host.port && target.rawUserInfo == null && target.path.startsWith("/link/workbench/")
        }.getOrDefault(false)
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (allowed(request.url)) return false
            if (request.url.toString() == identity.url + "/link/") { returnToDevices(); return true }
            if (request.url.scheme in listOf("https", "http", "mailto")) runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
            return true
        }
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (allowed(request.url) || request.url.scheme in listOf("blob", "data")) return null
            return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), java.io.ByteArrayInputStream(ByteArray(0)))
        }
        override fun onReceivedSslError(view: WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError) {
            // LAN self-signed certificates are trusted only by the QR's exact SPKI anchor.
            val trusted = identity.pin.isNotEmpty() && allowed(android.net.Uri.parse(error.url)) && runCatching {
                val bytes = android.net.http.SslCertificate.saveState(error.certificate).getByteArray("x509-certificate") ?: return@runCatching false
                val cert = java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(java.io.ByteArrayInputStream(bytes)) as java.security.cert.X509Certificate
                cert.checkValidity()
                MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded), Base64.getDecoder().decode(identity.pin))
            }.getOrDefault(false)
            if (trusted) handler.proceed() else handler.cancel()
        }
        override fun onPageFinished(view: WebView, url: String) {
            if (allowed(android.net.Uri.parse(url))) {
                appearance.pageReady(view)
                val target = URI(url)
                val path = target.rawPath + (target.rawQuery?.let { "?" + it } ?: "") + (target.rawFragment?.let { "#" + it } ?: "")
                getSharedPreferences("link_locations", Context.MODE_PRIVATE).edit().putString(identity.id, path).apply()
            }
        }
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && response.statusCode == 401) {
                if (view === webView) returnToDevices()
                workbenches.remove(identity.id, view); appearance.detach(view); view.destroy()
            }
        }
    }

    private fun returnToDevices() {
        bridge.showDevices()
        pendingBootstrap = null
        showView(localView)
        devicesButton.visibility = android.view.View.GONE
        microphoneRequest?.deny(); microphoneRequest = null
        uploadCallback?.onReceiveValue(null); uploadCallback = null
        workbenchIdentity = null; webView.stopLoading()
        webView.webViewClient = localClient(); webView.webChromeClient = android.webkit.WebChromeClient()
        webView.addJavascriptInterface(bridge, "LinkNative"); webView.loadUrl(START_URL)
    }
    fun workbenchFailed(message: String) {
        runOnUiThread {
            if (workbenchIdentity != null) { returnToDevices(); android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show() }
            else webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('link:workbench-error',{detail:${JSONObject.quote(message)}}));", null)
        }
    }
}

class LinkBridge(private val context: MainActivity, private val onIdentity: (String) -> Unit) {
    private val store = IdentityStore(context)
    private val executor = Executors.newFixedThreadPool(3)
    private val clients = ConcurrentHashMap<String, OkHttpClient>()
    private val pairs = ConcurrentHashMap<String, NativePair>()
    @Volatile private var pendingIdentity: Identity? = null
    @Volatile private var devicesVisible = true
    private val connectionGeneration = java.util.concurrent.atomic.AtomicLong()
    private val servers = SshServerManager(context) { identity -> store.write(identity, false) }
    private data class NativePair(val identity: Identity, val pollToken: String, val expiresAt: Long)
    private fun capabilities() = JSONObject().put("devices", true).put("ssh", true)
    fun showDevices() { connectionGeneration.incrementAndGet(); pendingIdentity = null; devicesVisible = true }
    private fun currentIdentity() = pendingIdentity ?: store.read()
    private fun canOpenAnother(id: String) = context.canOpenDevice(id)

    @JavascriptInterface
    fun bootstrap(): String = (currentIdentity()?.toJson() ?: JSONObject()).put("showDevices", devicesVisible)
        .put("capabilities", capabilities()).toString()

    @JavascriptInterface
    fun saveIdentity(raw: String): String {
        return try {
            var incoming = Identity.parse(JSONObject(raw))
            val existing = store.all().firstOrNull { it.hostKey == incoming.hostKey }
            if (existing != null && existing.token.isNotEmpty() && incoming.token.isNotEmpty() && existing.token != incoming.token && incoming.code.isEmpty()) {
                return errorJson("缺少一次性配对码")
            }
            if (existing != null && incoming.token.isEmpty() && incoming.code.isEmpty()) incoming = incoming.copy(token = existing.token)
            if (existing != null) incoming = incoming.copy(id = existing.id, kind = existing.kind, ssh = existing.ssh)
            if (incoming.token.isNotEmpty()) { store.write(incoming); pendingIdentity = null } else pendingIdentity = incoming
            connectionGeneration.incrementAndGet(); devicesVisible = false
            onIdentity(bootstrap())
            JSONObject().put("ok", true).toString()
        } catch (e: Exception) { errorJson(e.message ?: "无效的配对信息") }
    }

    @JavascriptInterface
    fun clearIdentity(): String { showDevices(); return JSONObject().put("ok", true).toString() }

    @JavascriptInterface
    fun scan(): String { context.launchScanner(); return JSONObject().put("ok", true).toString() }

    @JavascriptInterface
    fun openWorkbench(): String {
        val identity = store.read() ?: return errorJson("请先配对工作台")
        if (identity.token.isEmpty()) return errorJson("请先在电脑上允许连接")
        if (!canOpenAnother(identity.id)) return errorJson("已保留 4 个工作台，请先关闭暂不用的设备页面")
        val generation = connectionGeneration.get()
        executor.execute {
            runCatching {
                val client = clientFor(identity)
                val request = Request.Builder().url(identity.url + "/link/api/workbench").header("Authorization", "Bearer ${identity.token}").post("{}".toRequestBody("application/json".toMediaType())).build()
                client.newCall(request).execute().use { result ->
                    val body = JSONObject(result.body?.string() ?: "{}")
                    require(result.isSuccessful) { body.optString("error", "工作台连接失败") }
                    require(body.optString("url") == "/link/workbench/") { "工作台地址无效" }
                    val cookie = result.headers.values("Set-Cookie").singleOrNull { it.contains("Path=/link/workbench/", true) && it.contains("HttpOnly", true) } ?: throw IllegalStateException("工作台未返回设备会话")
                    if (generation == connectionGeneration.get() && store.selectedId() == identity.id) context.openWorkbench(identity, cookie) { generation == connectionGeneration.get() && store.selectedId() == identity.id }
                }
            }.onFailure { if (generation == connectionGeneration.get()) context.workbenchFailed(connectionFailureMessage(it, identity.url, identity.pin.isNotEmpty())) }
        }
        return JSONObject().put("ok", true).toString()
    }

    @JavascriptInterface
    fun deviceCall(raw: String): String {
        val input = runCatching { JSONObject(raw) }.getOrNull() ?: return errorJson("无效的设备请求")
        val requestId = input.optString("id")
        executor.execute {
            val result = try { JSONObject().put("ok", true).put("body", deviceAction(input)).toString() }
                catch (error: Exception) { errorJson(error.message ?: "设备操作失败") }
            context.runOnUiThread { context.deliverResult("window.__linkNativeResult && window.__linkNativeResult(" + JSONObject.quote(requestId) + "," + JSONObject.quote(result) + ");") }
        }
        return ""
    }

    private fun deviceAction(input: JSONObject): JSONObject {
        val targetId = input.optString("deviceId").ifBlank { input.optString("targetId") }
        return when (input.optString("action")) {
            "list" -> JSONObject().put("devices", org.json.JSONArray(store.all().map {
                it.publicJson(if (it.kind == "ssh") servers.status(it.id) else "unknown")
            })).put("activeId", store.selectedId()).put("capabilities", capabilities())
            "select" -> {
                val identity = store.get(targetId) ?: error("设备不存在")
                require(identity.kind != "ssh" || servers.status(identity.id) == "connected") { "SSH 隧道已断开，请重新连接" }
                require(canOpenAnother(identity.id)) { "已保留 4 个工作台，请先关闭暂不用的设备页面" }
                connectionGeneration.incrementAndGet(); store.select(identity.id); pendingIdentity = null; devicesVisible = false
                val launched = JSONObject(openWorkbench()); require(launched.optBoolean("ok")) { launched.optString("error") }
                JSONObject().put("device", identity.publicJson())
            }
            "closeWorkbench" -> { context.forgetDevice(targetId); JSONObject().put("ok", true) }
            "rename" -> {
                val identity = store.get(targetId) ?: error("设备不存在")
                val name = input.optString("name").trim(); require(name.isNotBlank() && name.length <= 128) { "设备名称须为 1–128 字" }
                val renamed = identity.copy(name = name); store.write(renamed, false)
                JSONObject().put("device", renamed.publicJson())
            }
            "remove" -> {
                if (store.selectedId() == targetId) showDevices()
                store.remove(targetId); servers.remove(targetId); context.forgetDevice(targetId)
                context.getSharedPreferences("link_locations", Context.MODE_PRIVATE).edit().remove(targetId).apply()
                JSONObject().put("ok", true)
            }
            "pair" -> {
                pairs.entries.removeIf { it.value.expiresAt <= System.currentTimeMillis() }
                require(pairs.size < 16) { "待批准连接过多" }
                val parsed = parsePairingLink(input.optString("uri"))
                val identity = Identity(parsed.url, parsed.pin, parsed.code, input.optString("name").trim().ifBlank { parsed.name.ifBlank { "电脑" } }.take(100), "")
                val pair = post(identity, "/link/api/pair", JSONObject().put("code", identity.code).put("name", identity.name))
                pairs[pair.getString("requestId")] = NativePair(identity, pair.getString("pollToken"), pair.optLong("expiresAt", System.currentTimeMillis() + 300000))
                JSONObject().put("requestId", pair.getString("requestId"))
            }
            "pairStatus" -> {
                val id = input.optString("requestId"); val pair = pairs[id] ?: error("配对请求已过期")
                val result = post(pair.identity, "/link/api/pair/status", JSONObject().put("requestId", id).put("pollToken", pair.pollToken))
                if (result.optString("status") == "approved") {
                    val previous = store.all().firstOrNull { it.hostKey == pair.identity.hostKey }
                    val device = pair.identity.copy(token = result.getString("token"), code = "", id = previous?.id ?: pair.identity.id)
                    store.write(device, false); pairs.remove(id)
                    JSONObject().put("status", "approved").put("device", device.publicJson())
                } else { if (result.optString("status") == "rejected") pairs.remove(id); JSONObject().put("status", result.optString("status")) }
            }
            "sshProbe" -> servers.probe(input)
            "sshConnect" -> servers.connect(input)
            "job" -> servers.job(input.optString("jobId").ifBlank { input.optString("targetId") })
            "reconnect" -> {
                val identity = store.get(targetId) ?: error("设备不存在")
                require(identity.kind == "ssh") { "该设备不是 SSH 服务器" }
                servers.connect(input, identity)
            }
            "serverAction" -> servers.manage(input, store.get(targetId) ?: error("设备不存在"))
            else -> error("不支持的设备操作")
        }
    }

    private fun post(identity: Identity, path: String, body: JSONObject): JSONObject {
        val request = Request.Builder().url(identity.url + path).post(body.toString().toRequestBody("application/json".toMediaType())).build()
        return clientFor(identity).newCall(request).execute().use { response ->
            val value = JSONObject(response.body?.string() ?: "{}")
            require(response.isSuccessful) { value.optString("error", "连接失败（HTTP " + response.code + "）") }; value
        }
    }

    @JavascriptInterface
    fun request(raw: String): String {
        val id = runCatching { JSONObject(raw).optString("id") }.getOrDefault("")
        executor.execute {
            val result = executeRequest(raw)
            context.runOnUiThread {
                val script = "window.__linkNativeResult && window.__linkNativeResult(${JSONObject.quote(id)},${JSONObject.quote(result)});"
                context.deliverResult(script)
            }
        }
        return ""
    }

    internal fun clientFor(identity: Identity): OkHttpClient = clients.getOrPut(identity.hostKey) {
            val uri = URI(identity.url)
            val builder = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
                .connectTimeout(12, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS)
            if (identity.pin.isNotEmpty()) {
                // The QR pin is the trust anchor for local self-signed certificates.
                val trust = object : javax.net.ssl.X509TrustManager {
                    override fun getAcceptedIssuers() = emptyArray<java.security.cert.X509Certificate>()
                    override fun checkClientTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) { throw java.security.cert.CertificateException("Client certificates unsupported") }
                    override fun checkServerTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) {
                        val leaf = chain.firstOrNull() ?: throw java.security.cert.CertificateException("Empty certificate")
                        leaf.checkValidity()
                        val actual = MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded)
                        val expected = Base64.getDecoder().decode(identity.pin)
                        if (!MessageDigest.isEqual(actual, expected)) throw java.security.cert.CertificateException("主机公钥与配对身份不匹配")
                    }
                }
                val tls = javax.net.ssl.SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
                builder.sslSocketFactory(tls.socketFactory, trust)
                builder.hostnameVerifier { hostname, session ->
                    hostname.equals(uri.host, ignoreCase = true) && runCatching {
                        val leaf = session.peerCertificates.firstOrNull() as? java.security.cert.X509Certificate
                            ?: return@runCatching false
                        leaf.checkValidity()
                        MessageDigest.isEqual(
                            MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded),
                            Base64.getDecoder().decode(identity.pin)
                        )
                    }.getOrDefault(false)
                }
            }
            builder.build()
            }

    private fun executeRequest(raw: String): String {
        var requestId = ""
        var hostUrl = ""
        var pinned = false
        return try {
            val input = JSONObject(raw)
            val id = input.optString("id")
            requestId = id
            val identity = currentIdentity() ?: return response(id, 0, "未配对")
            hostUrl = identity.url
            pinned = identity.pin.isNotEmpty()
            val method = input.optString("method").uppercase()
            if (method != "GET" && method != "POST") return response(id, 0, "仅支持 GET/POST")
            val path = input.optString("path")
            if (!Regex("^/link/api/[A-Za-z0-9/_-]+$").matches(path)) return response(id, 0, "路径未授权")
            val uri = URI(identity.url + path)
            if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.userInfo != null) return response(id, 0, "仅支持 HTTPS 主机")
            val client = clientFor(identity)
            val requestBuilder = Request.Builder().url(uri.toURL()).header("Accept", "application/json")
            if (identity.token.isNotEmpty()) requestBuilder.header("Authorization", "Bearer ${identity.token}")
            val body = input.optJSONObject("body")?.toString()?.toRequestBody("application/json".toMediaType())
            if (method == "POST") requestBuilder.post(body ?: "{}".toRequestBody("application/json".toMediaType()))
            val headers = input.optJSONObject("headers")
            if (headers != null) headers.keys().forEach { key -> if (key.equals("content-type", true)) requestBuilder.header(key, headers.optString(key)) }
            client.newCall(requestBuilder.build()).execute().use { result ->
                response(id, result.code, result.body?.string() ?: "")
            }
        } catch (e: Exception) { response(requestId, 0, connectionFailureMessage(e, hostUrl, pinned)) }
    }

    private fun response(id: String, status: Int, body: String): String = JSONObject().apply {
        put("id", id); put("ok", status in 200..299); put("status", status)
        if (status == 0) put("error", body) else put("body", runCatching { org.json.JSONTokener(body).nextValue() }.getOrDefault(body))
    }.toString()
    private fun errorJson(message: String) = JSONObject().put("ok", false).put("status", 0).put("error", message).toString()
    fun close() {
        connectionGeneration.incrementAndGet()
        servers.close()
        executor.shutdownNow()
        clients.values.forEach { it.dispatcher.executorService.shutdownNow(); it.connectionPool.evictAll() }
        clients.clear()
    }
}
