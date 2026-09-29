package com.tuckerswett.workouttracker.healthconnect

import androidx.activity.result.ActivityResultLauncher
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.TreeMap
import kotlin.reflect.KClass

/**
 * Bridges Android Health Connect (read-only) into the web app for SWE-31/SWE-32. Samsung Health,
 * MyFitnessPal, and anything else on the phone write into Health Connect; this plugin just
 * reads steps/sleep/weight/body fat/resting HR/nutrition back out and hands per-day totals to
 * JS, which merges them into `metricsStore` the same way it merges a Samsung CSV import.
 */
@CapacitorPlugin(name = "HealthConnect")
class HealthConnectPlugin : Plugin() {

    private val permissions = setOf(
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(SleepSessionRecord::class),
        HealthPermission.getReadPermission(WeightRecord::class),
        HealthPermission.getReadPermission(BodyFatRecord::class),
        HealthPermission.getReadPermission(RestingHeartRateRecord::class),
        HealthPermission.getReadPermission(NutritionRecord::class),
    )

    private lateinit var permissionLauncher: ActivityResultLauncher<Set<String>>
    private var pendingPermissionCall: PluginCall? = null

    /** Null whenever Health Connect isn't installed/updated — every method must check this. */
    private val client: HealthConnectClient?
        get() = if (HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE) {
            HealthConnectClient.getOrCreate(context)
        } else {
            null
        }

    override fun load() {
        super.load()
        // Must run in load(), before the activity reaches STARTED, per registerForActivityResult's
        // contract. Goes through the bridge (not the raw activity) so this also works when
        // Capacitor is hosted inside a Fragment.
        val contract = PermissionController.createRequestPermissionResultContract()
        permissionLauncher = bridge.registerForActivityResult(contract) { granted ->
            val call = pendingPermissionCall
            pendingPermissionCall = null
            call?.resolve(permissionResult(granted))
        }
    }

    private fun permissionResult(granted: Set<String>): JSObject {
        val result = JSObject()
        result.put("granted", JSArray(granted.toList()))
        result.put("allGranted", granted.containsAll(permissions))
        return result
    }

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val status = HealthConnectClient.getSdkStatus(context)
        val result = JSObject()
        result.put("available", status == HealthConnectClient.SDK_AVAILABLE)
        result.put("needsUpdate", status == HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED)
        call.resolve(result)
    }

    @PluginMethod
    fun getGrantedPermissions(call: PluginCall) {
        val hc = client ?: return call.reject("Health Connect is not available")
        CoroutineScope(Dispatchers.Main).launch {
            try {
                call.resolve(permissionResult(hc.permissionController.getGrantedPermissions()))
            } catch (e: Exception) {
                call.reject("Failed to read granted permissions: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        if (client == null) {
            call.reject("Health Connect is not available")
            return
        }
        pendingPermissionCall = call
        permissionLauncher.launch(permissions)
    }

    /** Opens Health Connect's own app-permissions screen, for a user who denied a permission
     *  and needs to grant it outside the in-app request dialog. */
    @PluginMethod
    fun openHealthConnectSettings(call: PluginCall) {
        try {
            activity.startActivity(HealthConnectClient.getHealthConnectManageDataIntent(context))
            call.resolve()
        } catch (e: Exception) {
            call.reject("Could not open Health Connect: ${e.message}", e)
        }
    }

    @PluginMethod
    fun readMetrics(call: PluginCall) {
        val hc = client ?: return call.reject("Health Connect is not available")
        val startEpochMs = call.getLong("startEpochMs")
        val endEpochMs = call.getLong("endEpochMs") ?: System.currentTimeMillis()
        if (startEpochMs == null) {
            call.reject("startEpochMs is required")
            return
        }

        CoroutineScope(Dispatchers.Main).launch {
            try {
                val days = readDailyMetrics(hc, Instant.ofEpochMilli(startEpochMs), Instant.ofEpochMilli(endEpochMs))
                val arr = JSArray()
                for (day in days.values) arr.put(day)
                val result = JSObject()
                result.put("days", arr)
                call.resolve(result)
            } catch (e: Exception) {
                call.reject("Failed to read Health Connect records: ${e.message}", e)
            }
        }
    }

    private suspend fun readDailyMetrics(hc: HealthConnectClient, start: Instant, end: Instant): Map<String, JSObject> {
        val zone = ZoneId.systemDefault()
        val fmt = DateTimeFormatter.ISO_LOCAL_DATE
        val days = TreeMap<String, JSObject>()
        fun dayFor(instant: Instant): String = instant.atZone(zone).toLocalDate().format(fmt)
        fun dayObj(date: String): JSObject = days.getOrPut(date) { JSObject().apply { put("date", date) } }

        val filter = TimeRangeFilter.between(start, end)

        // The user can grant some permissions and deny others in the Health Connect dialog;
        // read only what's actually granted so one denied type doesn't fail the whole sync.
        val granted = hc.permissionController.getGrantedPermissions()
        suspend fun <T : Record> readGranted(type: KClass<T>): List<T> =
            if (HealthPermission.getReadPermission(type) in granted) readAll(hc, type, filter) else emptyList()

        // Steps: sum every record per local day (Health Connect already dedupes overlapping
        // writes from the same source, and cross-source overlap is rare enough to ignore here).
        val stepTotals = LinkedHashMap<String, Long>()
        for (r in readGranted(StepsRecord::class)) {
            val date = dayFor(r.startTime)
            stepTotals[date] = (stepTotals[date] ?: 0L) + r.count
        }
        stepTotals.forEach { (date, total) -> dayObj(date).put("steps", total) }

        // Sleep: attribute each session to its end (wake-up) date; longest session wins the
        // day, matching the Samsung CSV import's sleep merge.
        val sleepMinutes = LinkedHashMap<String, Long>()
        for (r in readGranted(SleepSessionRecord::class)) {
            val date = dayFor(r.endTime)
            val minutes = Duration.between(r.startTime, r.endTime).toMinutes()
            if (minutes > (sleepMinutes[date] ?: 0L)) sleepMinutes[date] = minutes
        }
        sleepMinutes.forEach { (date, minutes) -> dayObj(date).put("sleepMin", minutes) }

        // Weight: average multiple same-day weigh-ins, in kilograms (JS converts to app units).
        average(readGranted(WeightRecord::class), { dayFor(it.time) }, { it.weight.inKilograms })
            .forEach { (date, avg) -> dayObj(date).put("weightKg", avg) }

        // Body fat percentage: average per local day.
        average(readGranted(BodyFatRecord::class), { dayFor(it.time) }, { it.percentage.value })
            .forEach { (date, avg) -> dayObj(date).put("bodyFat", avg) }

        // Resting heart rate: average bpm per local day.
        average(readGranted(RestingHeartRateRecord::class), { dayFor(it.time) }, { it.beatsPerMinute.toDouble() })
            .forEach { (date, avg) -> dayObj(date).put("restingHr", avg) }

        // Nutrition (e.g. MyFitnessPal logs one NutritionRecord per meal): sum calories and
        // macros per local day, attributed to the record's start time.
        val nutritionRecords = readGranted(NutritionRecord::class)
        sum(nutritionRecords, { dayFor(it.startTime) }, { it.energy?.inKilocalories })
            .forEach { (date, total) -> dayObj(date).put("calories", total) }
        sum(nutritionRecords, { dayFor(it.startTime) }, { it.protein?.inGrams })
            .forEach { (date, total) -> dayObj(date).put("proteinG", total) }
        sum(nutritionRecords, { dayFor(it.startTime) }, { it.totalCarbohydrate?.inGrams })
            .forEach { (date, total) -> dayObj(date).put("carbsG", total) }
        sum(nutritionRecords, { dayFor(it.startTime) }, { it.totalFat?.inGrams })
            .forEach { (date, total) -> dayObj(date).put("fatG", total) }

        return days
    }

    private fun <T> average(records: List<T>, dateOf: (T) -> String, valueOf: (T) -> Double): Map<String, Double> {
        val sums = LinkedHashMap<String, DoubleArray>() // [sum, count]
        for (r in records) {
            val acc = sums.getOrPut(dateOf(r)) { doubleArrayOf(0.0, 0.0) }
            acc[0] += valueOf(r)
            acc[1] += 1.0
        }
        return sums.mapValues { (_, acc) -> acc[0] / acc[1] }
    }

    /** Sums a nullable numeric field per local day, skipping records where it's absent
     *  (Health Connect nutrition fields are all optional — MyFitnessPal may omit some). */
    private fun <T> sum(records: List<T>, dateOf: (T) -> String, valueOf: (T) -> Double?): Map<String, Double> {
        val sums = LinkedHashMap<String, Double>()
        for (r in records) {
            val value = valueOf(r) ?: continue
            val date = dateOf(r)
            sums[date] = (sums[date] ?: 0.0) + value
        }
        return sums
    }

    /** Pages through every record in range — Health Connect caps a single read at 1000 rows. */
    private suspend fun <T : Record> readAll(hc: HealthConnectClient, type: KClass<T>, filter: TimeRangeFilter): List<T> {
        val out = mutableListOf<T>()
        var pageToken: String? = null
        do {
            val response = hc.readRecords(ReadRecordsRequest(type, filter, pageToken = pageToken))
            out.addAll(response.records)
            pageToken = response.pageToken
        } while (!pageToken.isNullOrEmpty())
        return out
    }
}
