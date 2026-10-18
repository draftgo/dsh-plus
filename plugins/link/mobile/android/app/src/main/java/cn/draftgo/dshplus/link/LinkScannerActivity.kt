package cn.draftgo.dshplus.link

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.CameraPreview
import com.journeyapps.barcodescanner.CaptureManager
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.Size

/** JourneyApps owns the camera and decoding; this screen only presents pairing controls. */
class LinkScannerActivity : AppCompatActivity() {
    private lateinit var scanner: DecoratedBarcodeView
    private lateinit var cameraState: View
    private lateinit var cameraTitle: TextView
    private lateinit var cameraDescription: TextView
    private lateinit var cameraAction: Button
    private lateinit var flashlight: Button
    private lateinit var feedback: TextView
    private var permissionRequested = false
    private var torchOn = false
    private var completed = false
    private var lastInvalidScan = 0L
    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCamera() else showPermissionHelp()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        setContentView(R.layout.activity_link_scanner)
        val root = findViewById<View>(R.id.scanner_root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(root)
        findViewById<Toolbar>(R.id.scanner_toolbar).setNavigationOnClickListener { finish() }
        permissionRequested = savedInstanceState?.getBoolean("camera_permission_requested") ?: false
        scanner = findViewById(R.id.link_barcode_scanner)
        cameraState = findViewById(R.id.camera_state)
        cameraTitle = findViewById(R.id.camera_state_title)
        cameraDescription = findViewById(R.id.camera_state_description)
        cameraAction = findViewById(R.id.camera_state_action)
        flashlight = findViewById(R.id.scanner_flashlight)
        feedback = findViewById(R.id.scanner_feedback)
        scanner.initializeFromIntent(intent)
        scanner.setStatusText("")
        scanner.barcodeView.addStateListener(object : CameraPreview.StateListener {
            override fun previewSized() {}
            override fun previewStopped() {}
            override fun cameraClosed() {}
            override fun previewStarted() {
                cameraState.visibility = View.GONE
                flashlight.isEnabled = true
            }
            override fun cameraError(error: Exception) {
                if (completed || isFinishing) return
                scanner.pause()
                flashlight.isEnabled = false
                showCameraState("相机暂时无法使用", "请关闭其他正在使用相机的应用，再试一次。", "重新打开相机") { startCamera() }
            }
        })
        scanner.addOnLayoutChangeListener { view, _, _, _, _, _, _, _, _ ->
            val side = (minOf(view.width, view.height) * 0.76f).toInt()
            if (side > 0) scanner.barcodeView.framingRectSize = Size(side, side)
        }
        scanner.decodeContinuous(object : BarcodeCallback {
            override fun barcodeResult(result: BarcodeResult) {
                if (completed) return
                val isPairing = runCatching { parsePairingLink(result.text) }.isSuccess
                if (!isPairing) {
                    val now = SystemClock.elapsedRealtime()
                    if (now - lastInvalidScan > 2500L) {
                        feedback.setText(R.string.scanner_wrong_code)
                        feedback.announceForAccessibility(getString(R.string.scanner_wrong_code))
                        lastInvalidScan = now
                    }
                    return
                }
                completed = true
                scanner.pause()
                setResult(RESULT_OK, CaptureManager.resultIntent(result, null))
                finish()
            }
        })
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)) flashlight.visibility = View.GONE
        flashlight.setOnClickListener {
            torchOn = !torchOn
            if (torchOn) scanner.setTorchOn() else scanner.setTorchOff()
            flashlight.setText(if (torchOn) R.string.scanner_flash_off else R.string.scanner_flash_on)
            flashlight.contentDescription = flashlight.text
        }
    }

    override fun onResume() {
        super.onResume()
        when {
            hasCameraPermission() -> startCamera()
            !permissionRequested -> requestCameraPermission()
            else -> showPermissionHelp()
        }
    }

    override fun onPause() {
        scanner.setTorchOff()
        torchOn = false
        flashlight.setText(R.string.scanner_flash_on)
        flashlight.isEnabled = false
        scanner.pause()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("camera_permission_requested", permissionRequested)
        super.onSaveInstanceState(outState)
    }

    private fun hasCameraPermission() = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun startCamera() {
        if (completed || isFinishing || !hasCameraPermission()) return
        cameraState.visibility = View.GONE
        feedback.setText(R.string.scanner_frame_hint)
        scanner.resume()
    }

    private fun requestCameraPermission() {
        permissionRequested = true
        permission.launch(Manifest.permission.CAMERA)
    }

    private fun showPermissionHelp() {
        val canRequest = shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
        showCameraState("允许相机，扫码连接", "相机仅用于识别电脑上的配对二维码。也可以返回后粘贴配对链接。", if (canRequest) "允许使用相机" else "前往设置") {
            if (canRequest) requestCameraPermission()
            else startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
    }

    private fun showCameraState(title: String, description: String, action: String, onAction: () -> Unit) {
        cameraTitle.text = title
        cameraDescription.text = description
        cameraAction.text = action
        cameraAction.setOnClickListener { onAction() }
        cameraState.visibility = View.VISIBLE
    }
}
