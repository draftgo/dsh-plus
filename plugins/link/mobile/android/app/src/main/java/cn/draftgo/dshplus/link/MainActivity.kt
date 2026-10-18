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
    private lateinit var bridge: LinkBridge
    private var pendingBootstrap: String? = null
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
        bridge = LinkBridge(this) { json ->
            pendingBootstrap = json
            dispatchBootstrap(json)
        }
        webView = WebView(this)
        setContentView(webView)
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
        webView.loadUrl(START_URL)
        intent?.data?.let { handlePairUri(it.toString()) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.data?.let { handlePairUri(it.toString()) }
    }

    override fun onDestroy() {
        microphoneRequest?.deny(); uploadCallback?.onReceiveValue(null)
        bridge.close()
        webView.removeJavascriptInterface("LinkNative")
        webView.destroy()
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

    fun deliverResult(script: String) { webView.evaluateJavascript(script, null) }

    fun openWorkbench(identity: Identity, cookie: String) {
        runOnUiThread {
            workbenchIdentity = identity
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
                if (accepted) webView.loadUrl(identity.url + "/link/workbench/")
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
            if (request.url.toString() == identity.url + "/link/") { returnToPairing(); return true }
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
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && response.statusCode == 401) returnToPairing()
        }
    }

    private fun returnToPairing() {
        bridge.clearIdentity()
        workbenchIdentity = null; webView.stopLoading()
        webView.webViewClient = localClient(); webView.webChromeClient = android.webkit.WebChromeClient()
        webView.addJavascriptInterface(bridge, "LinkNative"); webView.loadUrl(START_URL)
    }
    fun workbenchFailed(message: String) {
        runOnUiThread {
            if (workbenchIdentity != null) { returnToPairing(); android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show() }
            else webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('link:workbench-error',{detail:${JSONObject.quote(message)}}));", null)
        }
    }
}

class LinkBridge(private val context: MainActivity, private val onIdentity: (String) -> Unit) {
    private val store = IdentityStore(context)
    private val executor = Executors.newFixedThreadPool(3)
    private val clients = ConcurrentHashMap<String, OkHttpClient>()

    @JavascriptInterface
    fun bootstrap(): String = store.read()?.toJson()?.toString() ?: "{}"

    @JavascriptInterface
    fun saveIdentity(raw: String): String {
        return try {
            var incoming = Identity.parse(JSONObject(raw))
            val existing = store.read()
            if (existing != null && existing.hostKey != incoming.hostKey) {
                return error("该设备已信任另一台主机，请先清除设备身份")
            }
            if (existing != null && existing.token.isNotEmpty() && incoming.token.isNotEmpty() && existing.token != incoming.token && incoming.code.isEmpty()) {
                return error("缺少一次性配对码")
            }
            if (existing != null && existing.token.isNotEmpty() && incoming.token.isEmpty() && incoming.code.isEmpty()) {
                incoming = incoming.copy(token = existing.token, code = existing.code)
            }
            store.write(incoming)
            onIdentity(incoming.toJson().toString())
            JSONObject().put("ok", true).toString()
        } catch (e: Exception) { error(e.message ?: "无效的配对信息") }
    }

    @JavascriptInterface
    fun clearIdentity(): String { store.clear(); return JSONObject().put("ok", true).toString() }

    @JavascriptInterface
    fun scan(): String { context.launchScanner(); return JSONObject().put("ok", true).toString() }

    @JavascriptInterface
    fun openWorkbench(): String {
        val identity = store.read() ?: return error("请先配对工作台")
        if (identity.token.isEmpty()) return error("请先在电脑上允许连接")
        executor.execute {
            runCatching {
                val client = clientFor(identity)
                val request = Request.Builder().url(identity.url + "/link/api/workbench").header("Authorization", "Bearer ${identity.token}").post("{}".toRequestBody("application/json".toMediaType())).build()
                client.newCall(request).execute().use { result ->
                    val body = JSONObject(result.body?.string() ?: "{}")
                    require(result.isSuccessful) { body.optString("error", "工作台连接失败") }
                    require(body.optString("url") == "/link/workbench/") { "工作台地址无效" }
                    val cookie = result.headers.values("Set-Cookie").singleOrNull { it.contains("Path=/link/workbench/", true) && it.contains("HttpOnly", true) } ?: throw IllegalStateException("工作台未返回设备会话")
                    context.openWorkbench(identity, cookie)
                }
            }.onFailure { context.workbenchFailed(connectionFailureMessage(it, identity.url, identity.pin.isNotEmpty())) }
        }
        return JSONObject().put("ok", true).toString()
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

    private fun clientFor(identity: Identity): OkHttpClient = clients.getOrPut(identity.hostKey) {
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
            val identity = store.read() ?: return response(id, 0, "未配对")
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
    private fun error(message: String) = JSONObject().put("ok", false).put("status", 0).put("error", message).toString()
    fun close() {
        executor.shutdownNow()
        clients.values.forEach { it.dispatcher.executorService.shutdownNow(); it.connectionPool.evictAll() }
        clients.clear()
    }
}

data class Identity(val url: String, val pin: String, val code: String, val name: String, val token: String) {
    val hostKey: String get() = "$url|$pin"
    fun toJson() = JSONObject().apply { put("url", url); put("pin", pin); put("code", code); put("name", name); put("token", token) }
    companion object {
        fun parse(json: JSONObject): Identity {
            val url = json.optString("url").trim().trimEnd('/')
            val uri = URI(url)
            require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null && (uri.path.isNullOrEmpty() || uri.path == "/")) { "配对地址必须是 HTTPS 主机地址" }
            val pin = json.optString("pin").trim().removePrefix("sha256/")
            if (pin.isNotEmpty()) require(runCatching { Base64.getDecoder().decode(pin).size == 32 }.getOrDefault(false)) { "SPKI pin 无效" }
            val code = json.optString("code").trim()
            require(code.length <= 256) { "一次性配对码无效" }
            val token = json.optString("token").trim()
            require(token.length <= 4096) { "令牌过长" }
            require(code.isNotEmpty() || token.isNotEmpty()) { "缺少配对码或设备令牌" }
            return Identity(url, pin, code, json.optString("name").take(128), token)
        }
    }
}

private class IdentityStore(context: Context) {
    private val prefs = context.getSharedPreferences("link_identity", Context.MODE_PRIVATE)
    private val alias = "dsh-plus-link-identity"

    fun write(identity: Identity) {
        val keyStore = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = if (keyStore.containsAlias(alias)) keyStore.getKey(alias, null) as javax.crypto.SecretKey else {
            val generator = javax.crypto.KeyGenerator.getInstance("AES", "AndroidKeyStore")
            generator.init(android.security.keystore.KeyGenParameterSpec.Builder(alias, android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generator.generateKey()
        }
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding").apply { init(javax.crypto.Cipher.ENCRYPT_MODE, key) }
        val encoded = Base64.getEncoder().encodeToString(cipher.iv + cipher.doFinal(identity.toJson().toString().toByteArray()))
        prefs.edit().putString("value", encoded).apply()
    }
    fun read(): Identity? = runCatching {
        val raw = prefs.getString("value", null) ?: return null
        val bytes = Base64.getDecoder().decode(raw)
        val keyStore = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = keyStore.getKey(alias, null) as javax.crypto.SecretKey
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding").apply { init(javax.crypto.Cipher.DECRYPT_MODE, key, javax.crypto.spec.GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        Identity.parse(JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)))))
    }.getOrNull()
    fun clear() { prefs.edit().clear().apply(); runCatching { java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(alias) } } }
}
