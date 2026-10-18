package cn.draftgo.dshplus.link

import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException

internal fun connectionFailureMessage(error: Throwable, hostUrl: String, pinned: Boolean): String {
    val hostname = runCatching { URI(hostUrl).host?.removeSurrounding("[", "]")?.lowercase() }.getOrNull().orEmpty()
    val host = runCatching {
        val uri = URI(hostUrl)
        val hostname = uri.host ?: return@runCatching "主机"
        val displayHost = if (hostname.contains(':') && !hostname.startsWith('[')) "[$hostname]" else hostname
        "$displayHost:${if (uri.port == -1) 443 else uri.port}"
    }.getOrDefault("主机")
    val causes = generateSequence(error) { it.cause }.take(12).toList()
    // Certificate and pin failures must never be disguised as connectivity issues.
    if (causes.any { it is SSLException || it is CertificateException }) {
        return if (pinned) {
            "无法验证 $host 的安全身份。请检查手机和电脑的日期时间；若主机已重装或更换证书，请清除旧配对，再扫描该主机的新二维码。"
        } else {
            "无法建立与 $host 的安全连接。请检查手机的日期时间，并由管理员确认远程主机的 HTTPS 证书有效且域名匹配。"
        }
    }
    val parts = hostname.split('.').mapNotNull { it.toIntOrNull() }
    val localAddress = hostname.split('.').size == 4 && parts.size == 4 && parts.all { it in 0..255 } && (parts[0] == 10 || parts[0] == 127 ||
        (parts[0] == 172 && parts[1] in 16..31) || (parts[0] == 192 && parts[1] == 168) ||
        (parts[0] == 169 && parts[1] == 254)) || hostname == "localhost" || hostname == "::1" ||
        hostname.startsWith("fe80:") || hostname.startsWith("fc") && hostname.contains(':') ||
        hostname.startsWith("fd") && hostname.contains(':') || hostname.endsWith(".local") ||
        pinned && hostname.isNotEmpty() && !hostname.contains('.') && !hostname.contains(':')
    val networkHelp = if (localAddress) {
        "请确认运行 DSH Plus 的电脑已开启 Link，手机与它连接同一局域网（无需公网）；检查路由器的 AP 隔离或访客网络设置，并允许 Link 端口通过电脑防火墙。"
    } else {
        "请确认手机可以访问该 HTTPS 地址，远程主机的 Link 服务已开启；请由管理员检查 HTTPS 反向代理、端口和服务器防火墙。也可重新扫描主机的新配对二维码。"
    }
    return when {
        causes.any { it is UnknownHostException } -> "找不到主机 $host，请检查配对地址。$networkHelp"
        causes.any { it is SocketTimeoutException } -> "连接主机 $host 超时。$networkHelp"
        causes.any { it is ConnectException || it is NoRouteToHostException } -> "无法连接主机 $host。$networkHelp"
        error is IOException -> "与主机 $host 的连接中断，请检查网络后重试。"
        else -> "连接未完成，请重新打开 Link 并重试；仍失败时请重新扫描主机的配对二维码。"
    }
}
