package cn.draftgo.dshplus.link

import java.net.URI
import java.net.URLDecoder
import java.util.Base64

internal data class PairingLink(val url: String, val pin: String, val code: String, val name: String)

/** Accept only Link pairing formats; scanning never navigates to arbitrary URLs. */
internal fun parsePairingLink(raw: String): PairingLink {
    require(raw.length <= 16384) { "配对地址过长" }
    val uri = URI(raw.trim())
    require(!uri.isOpaque && uri.rawUserInfo == null) { "配对地址无效" }
    val query = pairingParameters(uri.rawQuery)
    val result = when (uri.scheme) {
        "dshlink" -> {
            require(uri.host == "pair" && uri.port == -1 && uri.rawFragment == null &&
                (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")) { "配对地址无效" }
            val hostUri = URI(query["url"] ?: error("配对地址缺少主机"))
            require(hostUri.rawQuery == null && hostUri.rawFragment == null &&
                (hostUri.rawPath.isNullOrEmpty() || hostUri.rawPath == "/")) { "配对主机地址无效" }
            PairingLink(httpsOrigin(hostUri), query["pin"] ?: error("配对地址缺少安全身份"),
                query["code"].orEmpty(), query["name"].orEmpty())
        }
        "https" -> {
            require(uri.rawPath in setOf("/link", "/link/", "/link/index.html")) { "请扫描 Link 配对页面的二维码" }
            val fragment = pairingParameters(uri.rawFragment)
            val queryCode = query["code"]
            val fragmentCode = fragment["code"]
            require(queryCode == null || fragmentCode == null || queryCode == fragmentCode) { "配对码存在冲突" }
            PairingLink(httpsOrigin(uri), "", fragmentCode ?: queryCode.orEmpty(),
                fragment["name"] ?: query["name"].orEmpty())
        }
        else -> error("请使用 Link 的 HTTPS 配对地址或本地配对码")
    }
    require(result.code.isNotBlank() && result.code.length <= 256 && result.code.none { it.isISOControl() }) { "配对地址缺少有效的一次性配对码" }
    if (result.pin.isNotEmpty()) {
        require(runCatching { Base64.getDecoder().decode(result.pin.removePrefix("sha256/")).size == 32 }.getOrDefault(false)) { "配对安全身份无效" }
    }
    return result.copy(pin = result.pin.removePrefix("sha256/"), name = result.name.take(128))
}

private fun httpsOrigin(uri: URI): String {
    require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null &&
        (uri.port == -1 || uri.port in 1..65535)) { "配对主机必须是有效的 HTTPS 地址" }
    return URI("https", null, uri.host, if (uri.port == 443) -1 else uri.port, null, null, null).toASCIIString()
}

private fun pairingParameters(raw: String?): Map<String, String> {
    if (raw.isNullOrEmpty()) return emptyMap()
    val result = mutableMapOf<String, String>()
    raw.split('&').filter { it.isNotEmpty() }.forEach { item ->
        val parts = item.split('=', limit = 2)
        val key = URLDecoder.decode(parts[0], "UTF-8")
        require(!result.containsKey(key)) { "配对参数重复" }
        result[key] = URLDecoder.decode(parts.getOrElse(1) { "" }, "UTF-8")
    }
    return result
}
