package cn.draftgo.dshplus.link

import org.junit.Assert.*
import org.junit.Test

class SshBoundariesTest {
    @Test fun fingerprintMatchesOpenSshSha256Format() {
        assertEquals("SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0", SshServerManager.fingerprint("abc".toByteArray()))
    }
    @Test fun shellQuotePreservesLiteralCommandsAndQuotes() {
        val untrusted = "a'b; " + "$" + "(id)\n"
        assertEquals("'a'\"'\"'b; " + "$" + "(id)\n'", SshServerManager.quote(untrusted))
    }
    @Test fun serverCookieHostsAreStableAndDifferent() {
        assertEquals(SshServerManager.loopback("server-a"), SshServerManager.loopback("server-a"))
        assertNotEquals(SshServerManager.loopback("server-a"), SshServerManager.loopback("server-b"))
        repeat(1000) {
            val octets = SshServerManager.loopback("server-" + it).split('.').map(String::toInt)
            assertEquals(127, octets.first()); assertTrue(octets.all { octet -> octet in 0..255 }); assertNotEquals(0, octets.last())
        }
    }
    @Test fun logsHideJsonUrlBearerAndPrivateKeys() {
        val original = "Bearer bearer-value https://host/?token=url-value&code=pair-value {\"token\":\"json-value\",\"password\":\"pass-value\"} -----BEGIN OPENSSH PRIVATE KEY-----private-value-----END OPENSSH PRIVATE KEY-----"
        val redacted = SshServerManager.redact(original)
        listOf("bearer-value", "url-value", "pair-value", "json-value", "pass-value", "private-value").forEach { assertFalse(it, redacted.contains(it)) }
    }
    @Test fun deviceKeysIncludeCertificateIdentity() {
        assertNotEquals(stableId("https://host", "first-key"), stableId("https://host", "second-key"))
    }
}
