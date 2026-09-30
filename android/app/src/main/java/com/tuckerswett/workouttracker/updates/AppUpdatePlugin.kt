package com.tuckerswett.workouttracker.updates

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Turns "a newer release exists" into one tap (TOM-2).
 *
 * The app is sideloaded, not on the Play Store, so nothing updates it for us. This plugin
 * downloads the release APK from GitHub and hands it to Android's package installer. The OS
 * still shows its own confirmation screen — that is not skippable and not something we would
 * want to skip — but everything before it is gone.
 *
 * Two things the OS requires, both handled here:
 *  - `REQUEST_INSTALL_PACKAGES` in the manifest, plus a one-time user grant of "install unknown
 *    apps" that only the OS settings screen can give. [getInfo] reports whether it is granted
 *    so the UI can send the board there once instead of failing silently.
 *  - A `content://` URI from a [FileProvider]. A `file://` URI throws FileUriExposedException on
 *    API 24+, which is this app's minSdk.
 *
 * If anything here breaks, the old path still works: the release page has the same APK, and
 * installing it by hand is exactly what the board did before this existed. This plugin never
 * modifies the installed app itself — the package installer does, and it enforces signature
 * match — so a failed or corrupt download leaves the working app in place.
 */
@CapacitorPlugin(name = "AppUpdate")
class AppUpdatePlugin : Plugin() {

    private val updateScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun handleOnDestroy() {
        updateScope.cancel()
        super.handleOnDestroy()
    }

    private companion object {
        val downloadInFlight = AtomicBoolean(false)
        const val DOWNLOAD_DIR = "updates"
        const val APK_MIME = "application/vnd.android.package-archive"
        /** A zip local-file-header signature: "PK". Every APK is a zip. */
        val ZIP_MAGIC = byteArrayOf(0x50, 0x4B, 0x03, 0x04)
        const val CONNECT_TIMEOUT_MS = 15_000
        const val READ_TIMEOUT_MS = 60_000
        /** Progress events are for a progress bar, not a byte counter; throttle them. */
        const val PROGRESS_INTERVAL_BYTES = 128 * 1024
    }

    /** True when this app may launch the package installer. Below API 26 there is no per-app
     *  setting — the global "unknown sources" toggle governs, and we cannot read it — so report
     *  true and let the install intent be the thing that surfaces a problem. */
    private fun canRequestInstalls(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            true
        }

    @PluginMethod
    fun getInfo(call: PluginCall) {
        val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
        val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            pkg.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            pkg.versionCode.toLong()
        }
        call.resolve(
            JSObject()
                .put("versionName", pkg.versionName ?: "")
                .put("versionCode", code)
                .put("canRequestInstalls", canRequestInstalls())
        )
    }

    /** Opens the OS screen that grants this app permission to install packages. There is no
     *  programmatic grant; this is the one unavoidable detour, and only on the first update. */
    @PluginMethod
    fun openInstallPermissionSettings(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Pre-26 has no per-app screen; the closest equivalent is Security settings.
            startSettings(call, Intent(Settings.ACTION_SECURITY_SETTINGS))
            return
        }
        startSettings(
            call,
            Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}"),
            ),
        )
    }

    private fun startSettings(call: PluginCall, intent: Intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Couldn't open the install-permission settings screen.", e)
        }
    }

    @PluginMethod
    fun downloadAndInstall(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) {
            call.reject("An APK url is required.")
            return
        }
        // Only ever fetch from the repo's own release hosts. GitHub redirects release asset
        // downloads to objects.githubusercontent.com, so both are allowed; anything else means
        // the URL did not come from where we think it did, and we refuse rather than install it.
        if (!isTrustedHost(url)) {
            call.reject("Refusing to download an APK from an unexpected host.")
            return
        }
        if (!canRequestInstalls()) {
            call.reject("NEEDS_INSTALL_PERMISSION")
            return
        }

        if (!downloadInFlight.compareAndSet(false, true)) {
            call.reject("An update download is already running.")
            return
        }
        updateScope.launch {
            try {
                val apk = withContext(Dispatchers.IO) { download(url) }
                launchInstaller(apk)
                call.resolve()
            } catch (e: Exception) {
                call.reject("The update download failed. Try again or use the release page.", e)
            }
        }.invokeOnCompletion {
            downloadInFlight.set(false)
        }
    }

    private fun isTrustedHost(url: String): Boolean {
        val parsed = runCatching { URL(url) }.getOrNull() ?: return false
        if (!parsed.protocol.equals("https", ignoreCase = true)) return false
        val host = parsed.host.lowercase()
        return host == "github.com" ||
            host == "api.github.com" ||
            host == "objects.githubusercontent.com" ||
            host == "release-assets.githubusercontent.com"
    }

    /** Downloads to the app cache. cacheDir is already covered by the FileProvider's
     *  `cache-path` (res/xml/file_paths.xml) and the OS reclaims it under storage pressure, so a
     *  stale APK can never accumulate into a real problem. */
    private fun download(url: String): File {
        val dir = File(context.cacheDir, DOWNLOAD_DIR)
        if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("Cannot create update cache.")
        // Unique files avoid replacing an APK while an earlier installer still has it open.
        // Android reclaims cache files under storage pressure.
        val target = File.createTempFile("workout-tracker-", ".apk", dir)
        val conn = openDownload(url)
        try {
            if (conn.responseCode !in 200..299) {
                throw IllegalStateException("GitHub returned HTTP ${conn.responseCode} for the APK.")
            }
            val totalBytes = conn.contentLengthLong
            var written = 0L
            var nextProgressAt = PROGRESS_INTERVAL_BYTES.toLong()
            conn.inputStream.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        output.write(buffer, 0, n)
                        written += n
                        if (written >= nextProgressAt) {
                            nextProgressAt = written + PROGRESS_INTERVAL_BYTES
                            notifyProgress(written, totalBytes)
                        }
                    }
                }
            }
            notifyProgress(written, totalBytes)

            // Fail loudly rather than launching the package installer on a truncated file or on
            // an HTML error page that happened to arrive with a 200.
            if (totalBytes > 0 && written != totalBytes) {
                throw IllegalStateException("Download was truncated at $written of $totalBytes bytes.")
            }
            if (!looksLikeApk(target)) {
                throw IllegalStateException("The downloaded file is not an APK.")
            }
            return target
        } catch (e: Exception) {
            target.delete()
            throw e
        } finally {
            conn.disconnect()
        }
    }

    /** Validate every hop before making the request; never follow redirects implicitly. */
    private fun openDownload(initialUrl: String): HttpURLConnection {
        var next = URL(initialUrl)
        repeat(6) {
            if (!isTrustedHost(next.toString())) throw IllegalStateException("Unexpected download host.")
            val conn = (next.openConnection() as HttpURLConnection).apply {
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                instanceFollowRedirects = false
                setRequestProperty("Accept", "application/octet-stream")
            }
            try {
                if (conn.responseCode !in listOf(301, 302, 303, 307, 308)) return conn
                val location = conn.getHeaderField("Location")
                    ?: throw IllegalStateException("Redirect without a location.")
                next = URL(next, location)
            } catch (e: Exception) {
                conn.disconnect()
                throw e
            }
            conn.disconnect()
        }
        throw IllegalStateException("Too many download redirects.")
    }

    private fun looksLikeApk(file: File): Boolean {
        if (file.length() < ZIP_MAGIC.size) return false
        val head = ByteArray(ZIP_MAGIC.size)
        file.inputStream().use { if (it.read(head) != head.size) return false }
        return head.contentEquals(ZIP_MAGIC)
    }

    private fun notifyProgress(bytes: Long, totalBytes: Long) {
        notifyListeners(
            "downloadProgress",
            JSObject().put("bytes", bytes).put("totalBytes", totalBytes.coerceAtLeast(0)),
        )
    }

    private fun launchInstaller(apk: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, APK_MIME)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }
}
