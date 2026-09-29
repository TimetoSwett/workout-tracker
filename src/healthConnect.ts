import { Capacitor, registerPlugin } from '@capacitor/core'
import type { DailyMetric } from './types'
import { getState, setSettings } from './store'
import { upsertMetric } from './metricsStore'
import { kgToUnits } from './units'
import { syncMetrics } from './metricsSync'
import { dropboxConfigured } from './dropbox'

export interface HealthConnectAvailability {
  available: boolean
  /** Health Connect is installed but too old to satisfy this app's minimum version. */
  needsUpdate: boolean
}

export interface HealthConnectPermissionResult {
  granted: string[]
  allGranted: boolean
}

export interface HealthConnectDay {
  date: string
  steps?: number
  sleepMin?: number
  weightKg?: number
  bodyFat?: number
  restingHr?: number
}

interface HealthConnectReadResult {
  days: HealthConnectDay[]
}

interface HealthConnectPlugin {
  isAvailable(): Promise<HealthConnectAvailability>
  getGrantedPermissions(): Promise<HealthConnectPermissionResult>
  requestPermissions(): Promise<HealthConnectPermissionResult>
  openHealthConnectSettings(): Promise<void>
  readMetrics(options: { startEpochMs: number; endEpochMs: number }): Promise<HealthConnectReadResult>
}

const HealthConnect = registerPlugin<HealthConnectPlugin>('HealthConnect')

/** Play Store listing for the Health Connect app, used when it isn't installed. */
export const HEALTH_CONNECT_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata'

/** Health data on Android only exists behind Health Connect; hide the feature everywhere else. */
export function isHealthConnectSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

export function getHealthConnectAvailability(): Promise<HealthConnectAvailability> {
  if (!isHealthConnectSupported()) return Promise.resolve({ available: false, needsUpdate: false })
  return HealthConnect.isAvailable()
}

/** Requests read permissions. Resolves once the system permission sheet is dismissed. */
export async function connectHealthConnect(): Promise<HealthConnectPermissionResult> {
  const result = await HealthConnect.requestPermissions()
  const settings = getState().settings
  setSettings({ ...settings, healthConnectConnected: settings.healthConnectConnected || result.granted.length > 0 })
  return result
}

export function getHealthConnectPermissions(): Promise<HealthConnectPermissionResult> {
  return HealthConnect.getGrantedPermissions()
}

/** Opens Health Connect's own permissions screen — the only fix once the in-app request
 *  dialog has already been dismissed with some permissions denied. */
export function openHealthConnectSettings(): Promise<void> {
  return HealthConnect.openHealthConnectSettings()
}

/** Rolling lookback window for every sync — simpler and more robust than an incremental
 *  cursor, since watches/companion apps can backfill Health Connect days after the fact.
 *  Re-syncing the same day just refreshes it in place (`metricsStore` is keyed by date). */
const SYNC_LOOKBACK_DAYS = 60

export interface HealthConnectSyncResult {
  days: { added: number; updated: number }
  error?: string
}

let syncing = false

export async function syncHealthConnectNow(): Promise<HealthConnectSyncResult> {
  if (syncing) return { days: { added: 0, updated: 0 }, error: 'Sync already in progress' }
  if (!isHealthConnectSupported()) return { days: { added: 0, updated: 0 }, error: 'Health Connect is only available on Android' }
  syncing = true
  try {
    const settings = getState().settings
    const endEpochMs = Date.now()
    const startEpochMs = endEpochMs - SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    const { days } = await HealthConnect.readMetrics({ startEpochMs, endEpochMs })
    const counts = { added: 0, updated: 0 }
    const now = Date.now()
    for (const d of days) {
      const metric: DailyMetric = { date: d.date, updatedAt: now, source: 'healthconnect' }
      if (d.steps != null) metric.steps = Math.round(d.steps)
      if (d.sleepMin != null) metric.sleepMin = Math.round(d.sleepMin)
      if (d.weightKg != null) metric.weight = kgToUnits(d.weightKg, settings.units)
      if (d.bodyFat != null) metric.bodyFat = Math.round(d.bodyFat * 10) / 10
      if (d.restingHr != null) metric.restingHr = Math.round(d.restingHr)
      const { added } = upsertMetric(metric)
      if (added) counts.added++
      else counts.updated++
    }
    setSettings({ ...getState().settings, healthConnectConnected: true, healthConnectLastSyncAt: now })
    if (dropboxConfigured(getState().settings)) void syncMetrics()
    return { days: counts }
  } catch (e) {
    return { days: { added: 0, updated: 0 }, error: e instanceof Error ? e.message : String(e) }
  } finally {
    syncing = false
  }
}
