package cn.draftgo.dshplus.link

import org.junit.Assert.*
import org.junit.Test

class PageAppearanceTest {
    @Test fun colorsAreStrictOpaqueHexWithoutCommandsOrAlpha() {
        assertNotNull(PageAppearance.parse("#fffdf8", "#1D292E"))
        for (invalid in listOf("white", "#fff", "#ffffffff", "#gg0011", "#123456;alert(1)", "", " #123456")) {
            assertNull(invalid, PageAppearance.parse(invalid, "#222222"))
            assertNull(invalid, PageAppearance.parse("#ffffff", invalid))
        }
    }
    @Test fun iconsUseActualBackgroundContrastRatherThanSystemPreference() {
        assertTrue(PageAppearance.parse("#fffdf8", "#1d292e")!!.darkSystemIcons)
        assertFalse(PageAppearance.parse("#171b1d", "#edf2f0")!!.darkSystemIcons)
        assertFalse(PageAppearance.parse("#222222", "#f3ebdf")!!.darkSystemIcons)
        assertTrue(PageAppearance.parse("#bbbbbb", "#222222")!!.darkSystemIcons)
    }
    @Test fun nativeInsetsMergeInsteadOfAddingKeyboardAndNavigation() {
        val bars = ContentInsets(0, 28, 0, 24)
        val ime = ContentInsets(0, 0, 0, 316)
        assertEquals(ContentInsets(0, 28, 0, 316), bars.merge(ime))
        assertEquals(ContentInsets(41, 28, 0, 24), bars.merge(ContentInsets(41, 0, 0, 0)))
        assertEquals(bars, bars.merge(ContentInsets(0, 0, 0, 0)))
    }
    @Test fun appearanceRequiresExactPairedOriginAndMainFrame() {
        val origin = "https://work.example:48721"
        val page = "$origin/link/workbench/"
        assertTrue(appearanceSourceAllowed(origin, origin, page, true))
        assertFalse(appearanceSourceAllowed(origin, origin, page, false))
        assertFalse(appearanceSourceAllowed(origin, "https://work.example", page, true))
        assertFalse(appearanceSourceAllowed(origin, "https://evil.example:48721", page, true))
        assertFalse(appearanceSourceAllowed(origin, origin, "https://other.example/link/workbench/", true))
        assertFalse(appearanceSourceAllowed(origin, origin, "$origin/link/", true))
        assertFalse(appearanceSourceAllowed(origin, origin, "https://user@work.example:48721/link/workbench/", true))
    }
    @Test fun localBridgeCannotBeUsedFromOtherAssetPaths() {
        val origin = "https://appassets.androidplatform.net"
        assertTrue(appearanceSourceAllowed(origin, origin, "$origin/assets/index.html", true))
        assertFalse(appearanceSourceAllowed(origin, origin, "$origin/assets/other.html", true))
        assertFalse(appearanceSourceAllowed(origin, "http://appassets.androidplatform.net", "$origin/assets/index.html", true))
    }
}
