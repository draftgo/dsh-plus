package cn.draftgo.dshplus.link

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest
import java.util.Base64

data class Identity(val url: String, val pin: String, val code: String, val name: String, val token: String,
    val id: String = stableId(url, pin), val kind: String = "computer", val ssh: JSONObject? = null, val warning: String = "") {
    val hostKey: String get() = "$url|$pin"
    fun toJson() = JSONObject().apply {
        put("url", url); put("pin", pin); put("code", code); put("name", name); put("token", token)
        put("id", id); put("kind", kind); if (ssh != null) put("ssh", ssh); if (warning.isNotBlank()) put("warning", warning)
    }
    fun publicJson(status: String = "unknown") = JSONObject().apply {
        put("id", id); put("name", name.ifBlank { if (kind == "ssh") ssh?.optString("host") ?: "服务器" else URI(url).host })
        if (warning.isNotBlank()) put("warning", warning)
        put("kind", kind); put("url", if (kind == "ssh") "ssh://" + ssh?.optString("host") else url); put("status", status)
    }
    companion object {
        fun parse(json: JSONObject): Identity {
            val url = json.optString("url").trim().trimEnd('/')
            val uri = URI(url)
            require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null && (uri.path.isNullOrEmpty() || uri.path == "/") && (uri.port == -1 || uri.port in 1..65535)) { "配对地址必须是 HTTPS 主机地址" }
            val pin = json.optString("pin").trim().removePrefix("sha256/")
            if (pin.isNotEmpty()) require(runCatching { Base64.getDecoder().decode(pin).size == 32 }.getOrDefault(false)) { "SPKI pin 无效" }
            val code = json.optString("code").trim()
            val token = json.optString("token").trim()
            require(code.length <= 256 && token.length <= 4096) { "设备凭据无效" }
            require(code.isNotEmpty() || token.isNotEmpty()) { "缺少配对码或设备令牌" }
            return Identity(url, pin, code, json.optString("name").take(128), token, json.optString("id").ifBlank { stableId(url, pin) }, json.optString("kind", "computer"), json.optJSONObject("ssh"), json.optString("warning"))
        }
    }
}

internal fun stableId(url: String, pin: String): String = MessageDigest.getInstance("SHA-256").digest("$url|$pin".toByteArray()).take(16).joinToString("") { "%02x".format(it) }

/** The encrypted document migrates the original single identity without dropping its token. */
internal class IdentityStore(context: Context) {
    private val prefs = context.getSharedPreferences("link_identity", Context.MODE_PRIVATE)
    private val alias = "dsh-plus-link-identity"
    private val devices = linkedMapOf<String, Identity>()
    private var activeId = ""
    private var unreadable = false
    init {
        val raw = prefs.getString("value", null)
        if (raw != null) {
            try {
                val value = JSONObject(decrypt(raw))
                if (value.has("devices")) {
                    val list = value.getJSONArray("devices")
                    for (i in 0 until list.length()) { val device = Identity.parse(list.getJSONObject(i)); devices[device.id] = device }
                    activeId = value.optString("activeId")
                } else { val legacy = Identity.parse(value); devices[legacy.id] = legacy; activeId = legacy.id; persist() }
            } catch (_: Exception) { unreadable = true }
        }
    }
    @Synchronized fun read(): Identity? = devices[activeId]
    @Synchronized fun get(id: String): Identity? = devices[id]
    @Synchronized fun all(): List<Identity> = devices.values.toList()
    @Synchronized fun selectedId(): String = activeId
    @Synchronized fun write(identity: Identity, select: Boolean = true) {
        require(!unreadable) { "设备凭据无法解密，请检查系统密钥；已保留原有数据" }
        require(identity.token.isNotEmpty()) { "仅保存已授权设备" }
        val previous = devices[identity.id]; val previousActive = activeId
        devices[identity.id] = identity.copy(code = "")
        if (select) activeId = identity.id
        try { persist() } catch (error: Exception) { if (previous == null) devices.remove(identity.id) else devices[identity.id] = previous; activeId = previousActive; throw error }
    }
    @Synchronized fun select(id: String): Identity {
        require(!unreadable) { "设备凭据无法解密；已保留原有数据" }
        val device = devices[id] ?: error("设备不存在")
        val before = activeId; activeId = id
        try { persist() } catch (error: Exception) { activeId = before; throw error }; return device
    }
    @Synchronized fun remove(id: String) {
        require(!unreadable) { "设备凭据无法解密；已保留原有数据" }
        val before = devices.remove(id) ?: return
        val previousActive = activeId; if (activeId == id) activeId = ""
        try { persist() } catch (error: Exception) { devices[id] = before; activeId = previousActive; throw error }
    }
    private fun key(create: Boolean): javax.crypto.SecretKey {
        val keys = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keys.containsAlias(alias)) return keys.getKey(alias, null) as javax.crypto.SecretKey
        require(create) { "设备密钥不可用" }
        val generator = javax.crypto.KeyGenerator.getInstance("AES", "AndroidKeyStore")
        generator.init(android.security.keystore.KeyGenParameterSpec.Builder(alias, android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE).build())
        return generator.generateKey()
    }
    private fun decrypt(raw: String): String {
        val bytes = Base64.getDecoder().decode(raw); require(bytes.size > 28)
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding").apply { init(javax.crypto.Cipher.DECRYPT_MODE, key(false), javax.crypto.spec.GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)))
    }
    private fun persist() {
        val value = JSONObject().put("version", 2).put("activeId", activeId).put("devices", JSONArray(devices.values.map { it.toJson() }))
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding").apply { init(javax.crypto.Cipher.ENCRYPT_MODE, key(true)) }
        val encoded = Base64.getEncoder().encodeToString(cipher.iv + cipher.doFinal(value.toString().toByteArray()))
        check(prefs.edit().putString("value", encoded).commit()) { "无法保存设备连接" }
    }
}
