package cn.draftgo.dshplus.link

import org.junit.Assert.*
import org.junit.Test

class PageDeviceNavigationTest {
    private val origin = "https://work.example:48721"

    @Test fun onlyPairedMainWorkbenchCanControlDeviceNavigation() {
        val page = "$origin/link/workbench/conversations/session?mode=chat#latest"
        assertTrue(deviceNavigationSourceAllowed(origin, origin, page, true))
        assertFalse(deviceNavigationSourceAllowed(origin, origin, page, false))
        assertFalse(deviceNavigationSourceAllowed(origin, "https://other.example:48721", page, true))
        assertFalse(deviceNavigationSourceAllowed(origin, "https://work.example", page, true))
        assertFalse(deviceNavigationSourceAllowed(origin, origin, "https://other.example:48721/link/workbench/", true))
        assertFalse(deviceNavigationSourceAllowed(origin, origin, "$origin/link/", true))
        assertFalse(deviceNavigationSourceAllowed(origin, origin, "$origin/link/workbench-other/", true))
        assertFalse(deviceNavigationSourceAllowed(origin, origin, "https://user@work.example:48721/link/workbench/", true))
        val local = "https://appassets.androidplatform.net"
        assertFalse(deviceNavigationSourceAllowed(local, local, "$local/assets/index.html", true))
    }

    @Test fun encodedTraversalAndInvalidUrlsCannotClaimWorkbenchReadiness() {
        for (path in listOf("../api/devices", "%2e%2e/api", "%252e%252e/api", "%2f../api", "%5c..%5capi", "./")) {
            assertFalse(path, deviceNavigationSourceAllowed(origin, origin, "$origin/link/workbench/$path", true))
        }
        assertFalse(deviceNavigationSourceAllowed(origin, origin, "not a url", true))
    }

    @Test fun nativeFallbackRemainsUntilPageExplicitlyReportsReady() {
        val state = PageDeviceNavigation()
        assertFalse(state.ready)
        assertFalse(state.accept("dsh-devices:show"))
        assertFalse(state.accept("arbitrary-command"))
        assertTrue(state.accept("dsh-devices:ready"))
        assertTrue(state.ready)
        assertTrue(state.accept("dsh-devices:show"))
        assertTrue(state.accept("dsh-devices:unready"))
        assertFalse(state.ready)
        assertFalse(state.accept("dsh-devices:show"))
    }

    @Test fun navigationAndCacheSwitchRequireFreshReady() {
        val state = PageDeviceNavigation()
        state.accept("dsh-devices:ready")
        state.recheck()
        assertFalse(state.ready)
        assertTrue(state.accept("dsh-devices:ready"))
        state.start()
        assertFalse(state.ready)
        assertFalse(state.accept("dsh-devices:show"))
        assertTrue(state.accept("dsh-devices:ready"))
        assertTrue(state.ready)
    }

    @Test fun cachedPagesKeepIndependentReadiness() {
        val first = PageDeviceNavigation()
        val second = PageDeviceNavigation()
        first.accept("dsh-devices:ready")
        assertFalse(second.ready)
        second.accept("dsh-devices:ready")
        first.fail()
        assertTrue(second.ready)
    }

    @Test fun failedPageCannotHideFallbackUntilAnotherNavigation() {
        val state = PageDeviceNavigation()
        state.accept("dsh-devices:ready")
        state.fail()
        assertTrue(state.failed)
        assertFalse(state.ready)
        assertFalse(state.accept("dsh-devices:ready"))
        assertFalse(state.accept("dsh-devices:show"))
        state.recheck()
        assertTrue(state.failed)
        assertFalse(state.accept("dsh-devices:ready"))
        state.start()
        assertFalse(state.failed)
        assertTrue(state.accept("dsh-devices:ready"))
    }
}
