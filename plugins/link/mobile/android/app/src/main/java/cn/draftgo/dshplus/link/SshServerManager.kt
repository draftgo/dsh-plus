package cn.draftgo.dshplus.link

import android.content.Context
import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.ChannelSftp
import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import com.jcraft.jsch.UserInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.Security
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Each phone owns its SSH session and tunnels; no desktop relay or saved SSH credentials. */
internal class SshServerManager(private val context: Context, private val onDevice: (Identity) -> Unit) {
    private val executor = Executors.newFixedThreadPool(2)
    private val connections = ConcurrentHashMap<String, Session>()
    private val jobs = ConcurrentHashMap<String, JSONObject>()
    private val activeTargets = ConcurrentHashMap.newKeySet<String>()
    init {
        // Android's built-in BC predates modern OpenSSH keys. Use the bundled maintained provider.
        if (Security.getProvider("BC")?.javaClass?.name != "org.bouncycastle.jce.provider.BouncyCastleProvider") {
            Security.removeProvider("BC"); Security.addProvider(org.bouncycastle.jce.provider.BouncyCastleProvider())
        }
    }
    private data class Target(val host: String, val port: Int, val username: String) {
        val key get() = "$username@$host:$port"
        fun json(fingerprint: String) = JSONObject().put("host", host).put("port", port).put("username", username).put("fingerprint", fingerprint)
    }
    private fun target(input: JSONObject): Target {
        val host = input.optString("host").trim()
        val port = input.optInt("port", 22)
        val username = input.optString("username").trim()
        require(host.isNotEmpty() && host.length <= 253 && host.none { it.isWhitespace() || it.isISOControl() || it in "/\\@?#" }) { "请输入有效的服务器 IP 或域名" }
        require(port in 1..65535) { "SSH 端口须为 1–65535" }
        require(Regex("[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}").matches(username)) { "请输入有效的 SSH 用户名" }
        return Target(host, port, username)
    }
    fun probe(input: JSONObject): JSONObject {
        val target = target(input)
        var seen = ""
        val session = JSch().getSession(target.username, target.host, target.port)
        session.hostKeyRepository = repository { key -> seen = fingerprint(key); true }
        session.setConfig("StrictHostKeyChecking", "yes")
        session.setConfig("PreferredAuthentications", "none")
        try { session.connect(12000) } catch (error: Exception) { if (seen.isEmpty()) throw IllegalStateException("无法读取 SSH 主机身份，请检查地址、端口及网络") }
        finally { session.disconnect() }
        require(seen.isNotEmpty()) { "服务器未返回 SSH 主机身份" }
        return JSONObject().put("fingerprint", seen)
    }
    fun connect(input: JSONObject, existing: Identity? = null): JSONObject {
        val settings = existing?.ssh ?: input
        val target = target(settings)
        require(existing == null || connections[existing.id]?.isConnected != true) { "服务器已连接，无需重复建立隧道" }
        val expected = settings.optString("fingerprint")
        require(Regex("SHA256:[A-Za-z0-9+/]{43}=?").matches(expected)) { "请先确认服务器 SSH 指纹" }
        require(activeTargets.add(target.key)) { "该服务器已有连接任务进行中" }
        val id = UUID.randomUUID().toString()
        val state = JSONObject().put("id", id).put("state", "running").put("steps", JSONArray())
        jobs[id] = state
        while (jobs.size > 32) jobs.entries.firstOrNull { it.key != id && it.value.optString("state") != "running" }?.let { jobs.remove(it.key) } ?: break
        val credentials = JSONObject(input.toString())
        executor.execute {
            var session: Session? = null
            try {
                step(state, "验证主机身份")
                session = authenticate(target, expected, credentials)
                step(state, "检查并准备服务")
                val savedPort = existing?.ssh?.optInt("remotePort", 0) ?: 0
                val deployed = if (existing != null && savedPort in 1..65535) {
                    val check = session.openChannel("direct-tcpip") as com.jcraft.jsch.ChannelDirectTCPIP
                    try { check.setHost("127.0.0.1"); check.setPort(savedPort); check.connect(10000) }
                    finally { check.disconnect() }
                    JSONObject().put("port", savedPort).put("pin", existing.pin).put("token", existing.token).put("warning", existing.warning)
                } else deploy(session, input.optString("source", "mirror"), "connect")
                step(state, "建立安全隧道")
                val deviceId = existing?.id ?: stableId("ssh://" + target.key, expected)
                // Cookies are scoped by host, not port: every SSH device gets its own loopback address.
                val address = loopback(deviceId)
                val preferredPort = existing?.let { java.net.URI(it.url).port }?.takeIf { it in 1..65535 } ?: 0
                val localPort = session.setPortForwardingL(address, preferredPort, "127.0.0.1", deployed.getInt("port"))
                val device = Identity.parse(JSONObject().put("url", "https://$address:$localPort").put("pin", deployed.getString("pin"))
                    .put("warning", deployed.optString("warning")).put("token", deployed.optString("token").ifBlank { existing?.token ?: error("服务器未签发授权") }).put("id", deviceId).put("kind", "ssh").put("ssh", target.json(expected).put("remotePort", deployed.getInt("port")))
                    .put("name", input.optString("name").trim().ifBlank { existing?.name ?: target.host }))
                onDevice(device)
                connections.put(device.id, session)?.disconnect()
                session = null
                synchronized(state) { finishSteps(state); state.put("state", "completed").put("device", device.publicJson("connected")) }
            } catch (error: Exception) {
                synchronized(state) { state.put("state", "failed").put("error", safeError(error)) }
            } finally {
                session?.disconnect(); credentials.remove("password"); credentials.remove("privateKey"); credentials.remove("passphrase")
                activeTargets.remove(target.key)
            }
        }
        return JSONObject().put("jobId", id)
    }
    fun job(id: String): JSONObject {
        val state = jobs[id] ?: error("连接任务不存在或已过期")
        return synchronized(state) { JSONObject(state.toString()) }
    }
    fun status(id: String): String = if (connections[id]?.isConnected == true) "connected" else "disconnected"
    fun remove(id: String) { connections.remove(id)?.disconnect() }
    fun manage(input: JSONObject, device: Identity): JSONObject {
        val session = connections[device.id]?.takeIf { it.isConnected } ?: error("SSH 已断开，请先重新连接")
        val operation = input.optString("operation")
        val command = when (operation) {
            "status" -> "systemctl --user show dsh-plus.service --property=ActiveState --property=SubState --no-pager"
            "start", "stop", "restart" -> "systemctl --user $operation dsh-plus.service"
            "logs" -> "journalctl --user -u dsh-plus.service --no-pager -n 80 -o cat"
            "update" -> {
                require(activeTargets.add(device.id)) { "该服务器正在更新" }
                val id = UUID.randomUUID().toString()
                val state = JSONObject().put("id", id).put("state", "running").put("steps", JSONArray())
                jobs[id] = state
                executor.execute {
                    try {
                        step(state, "更新服务器插件")
                        val result = deploy(session, input.optString("source", "mirror"), "update")
                        synchronized(state) { finishSteps(state); state.put("state", "completed").put("version", result.optString("version")) }
                    } catch (error: Exception) { synchronized(state) { state.put("state", "failed").put("error", safeError(error)) } }
                    finally { activeTargets.remove(device.id) }
                }
                return JSONObject().put("jobId", id)
            }
            else -> error("不支持的服务器操作")
        }
        val result = exec(session, "export XDG_RUNTIME_DIR=\"/run/user/\$(id -u)\"; export DBUS_SESSION_BUS_ADDRESS=\"unix:path=\$XDG_RUNTIME_DIR/bus\"; " + command, 30000)
        return JSONObject().put("ok", true).put("output", redact(result).takeLast(32768))
    }
    private fun authenticate(target: Target, expected: String, input: JSONObject): Session {
        val jsch = JSch()
        val privateKey = input.optString("privateKey").toByteArray()
        val passphrase = input.optString("passphrase").toByteArray()
        try { if (privateKey.isNotEmpty()) jsch.addIdentity("dsh-plus-session", privateKey, null, passphrase) }
        finally { privateKey.fill(0); passphrase.fill(0) }
        val session = jsch.getSession(target.username, target.host, target.port)
        session.hostKeyRepository = repository { MessageDigest.isEqual(fingerprint(it).toByteArray(), expected.toByteArray()) }
        session.setConfig("StrictHostKeyChecking", "yes")
        session.setConfig("PreferredAuthentications", if (input.optString("privateKey").isNotBlank()) "publickey" else "password,keyboard-interactive")
        val password = input.optString("password").toByteArray()
        if (password.isNotEmpty()) session.setPassword(password)
        session.serverAliveInterval = 20000; session.serverAliveCountMax = 3
        return try { session.connect(20000); session }
        catch (error: Exception) { session.disconnect(); throw error }
        finally { password.fill(0); jsch.removeAllIdentity() }
    }
    private fun deploy(session: Session, source: String, operation: String): JSONObject {
        require(source == "mirror" || source == "github") { "下载源无效" }
        val home = exec(session, "printf '%s' \"$" + "HOME\"", 10000).trim()
        require(home.startsWith("/") && home.length < 4096 && home.none { it == '\n' || it == '\r' || it == '\u0000' }) { "无法读取服务器用户目录" }
        val directory = "$home/.cache/dsh-plus-bootstrap-" + UUID.randomUUID().toString().replace("-", "")
        exec(session, "umask 077; mkdir -p " + quote(directory), 10000)
        try {
            val sftp = session.openChannel("sftp") as ChannelSftp
            try {
                sftp.connect(15000)
                for (file in listOf("server-seed.tar.gz", "manifest.json", "bootstrap.sh", "bootstrap.mjs")) {
                    context.assets.open("server/" + if (file == "server-seed.tar.gz") "server-seed.bundle" else file).use { sftp.put(it, "$directory/$file") }
                    sftp.chmod(384, "$directory/$file")
                }
            } finally { sftp.disconnect() }
            val result = exec(session, "bash " + quote("$directory/bootstrap.sh") + " " + quote(source) + " " + quote(operation), TimeUnit.MINUTES.toMillis(12))
            val json = result.lineSequence().map { it.trim() }.lastOrNull { it.startsWith("{") && it.endsWith("}") } ?: error("安装器未返回有效结果")
            val value = JSONObject(json)
            require(value.optInt("port") in 1..65535 && value.optString("pin").isNotEmpty() && (operation == "update" || value.optString("token").isNotEmpty())) { "服务器授权信息不完整" }
            return value
        } finally { runCatching { exec(session, "rm -rf -- " + quote(directory), 10000) } }
    }
    private fun exec(session: Session, command: String, timeout: Long): String {
        val channel = session.openChannel("exec") as ChannelExec
        val output = ByteArrayOutputStream()
        val errors = ByteArrayOutputStream()
        channel.setCommand(command); channel.setInputStream(null); channel.setOutputStream(output); channel.setErrStream(errors)
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout)
        try {
            channel.connect(15000)
            while (!channel.isClosed) {
                require(System.nanoTime() < deadline) { "服务器操作超时，请重试" }
                require(output.size() <= 2 * 1024 * 1024 && errors.size() <= 2 * 1024 * 1024) { "服务器响应过大" }
                Thread.sleep(100)
            }
            check(channel.exitStatus == 0) { "服务器命令执行失败（" + channel.exitStatus + "）：" + redact(errors.toString("UTF-8")).takeLast(1000) }
            return output.toString("UTF-8")
        } finally { channel.disconnect() }
    }
    private fun finishSteps(state: JSONObject) { val steps = state.getJSONArray("steps"); for (i in 0 until steps.length()) steps.getJSONObject(i).put("state", "completed") }
    private fun step(state: JSONObject, text: String) { synchronized(state) { finishSteps(state); state.getJSONArray("steps").put(JSONObject().put("label", text).put("state", "running")) } }
    private fun safeError(error: Exception): String {
        val message = error.message.orEmpty()
        return when {
            "HostKey" in message || "reject HostKey" in message || "host key" in message.lowercase() -> "SSH 主机指纹与确认值不一致，已停止连接"
            "Auth" in message || "authentication" in message.lowercase() -> "SSH 认证失败，请检查用户名和密码或私钥"
            "timeout" in message.lowercase() -> "SSH 连接超时，请检查网络和服务器"
            error is IllegalArgumentException || error is IllegalStateException -> redact(message).take(1200)
            else -> "SSH 连接失败，请检查网络、凭据和服务器环境"
        }
    }
    fun close() { executor.shutdownNow(); connections.values.forEach { it.disconnect() }; connections.clear(); jobs.clear() }
    companion object {
        internal fun fingerprint(key: ByteArray): String = "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(key))
        internal fun quote(value: String): String = "'" + value.replace("'", "'\"'\"'") + "'"
        internal fun loopback(id: String): String { val bytes = MessageDigest.getInstance("SHA-256").digest(id.toByteArray()); return "127." + ((bytes[0].toInt() and 0x7f) + 1) + "." + (bytes[1].toInt() and 0xff) + "." + ((bytes[2].toInt() and 0xfe) + 1) }
        internal fun redact(value: String): String = value
            .replace(Regex("(?i)(bearer\\s+)[A-Za-z0-9_.~+/-]+"), "$1[已隐藏]")
            .replace(Regex("(?i)((?:token|password|secret|authorization|api[_-]?key|code)[\\\"']?\\s*[=:]\\s*[\\\"']?)[^\\s,\\\"'&}]+"), "$1[已隐藏]")
            .replace(Regex("(?s)-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----"), "[私钥已隐藏]")
        private fun repository(verify: (ByteArray) -> Boolean) = object : HostKeyRepository {
            override fun check(host: String, key: ByteArray): Int = if (verify(key)) HostKeyRepository.OK else HostKeyRepository.CHANGED
            override fun add(hostkey: HostKey, ui: UserInfo?) = Unit
            override fun remove(host: String, type: String) = Unit
            override fun remove(host: String, type: String, key: ByteArray) = Unit
            override fun getKnownHostsRepositoryID(): String = "DSH-Plus confirmed SSH identity"
            override fun getHostKey(): Array<HostKey> = emptyArray()
            override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()
        }
    }
}
