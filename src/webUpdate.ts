/** A waiting service worker has finished caching an actual deployment from this
 * origin. A GitHub release alone is never evidence that web assets are ready. */
let readyWorker: ServiceWorker | null = null

/** Every reload in this module goes through here. A page can only navigate away
 * once, and two code paths race to send it: the `controllerchange` watcher below
 * and `activateWebUpdate()` in the tab that pressed the button. Whichever wins,
 * the other must not fire a second navigation on top of an in-flight one. */
let reloading = false
function reloadOnce(): void {
  if (reloading) return
  reloading = true
  location.reload()
}

/** `clientsClaim` means one tab activating a deployment takes over *every* open
 * tab, and the new worker prunes precache entries the old build still needs. A
 * claimed-but-unreloaded tab looks healthy until it asks for a lazy chunk whose
 * hash no longer exists on the origin, and then that import just rejects.
 *
 * Reload on controller change so no tab outlives the assets it was built from.
 * Call once at startup, before anything can activate a worker. */
export function reloadOnControllerChange(): void {
  if (!('serviceWorker' in navigator)) return
  // Skip the first claim of a page loaded without a controller, but remain
  // subscribed: that same tab must reload when a later deployment claims it.
  let controlled = Boolean(navigator.serviceWorker.controller)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!navigator.serviceWorker.controller) return
    if (controlled) reloadOnce()
    controlled = true
  })
}

export async function webUpdateReady(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    if (!registration || !navigator.serviceWorker.controller) return false
    // A cached waiting worker remains installable when the network is offline.
    readyWorker = registration.waiting
    if (readyWorker?.state === 'installed') return true
    await registration.update()
    const installing = registration.installing
    if (installing) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          installing.removeEventListener('statechange', changed)
          resolve()
        }
        const changed = () => {
          if (installing.state === 'installed' || installing.state === 'redundant') finish()
        }
        const timer = setTimeout(finish, 8000)
        installing.addEventListener('statechange', changed)
        changed()
      })
    }
    readyWorker = registration.waiting
    return readyWorker?.state === 'installed'
  } catch {
    readyWorker = null
    return false
  }
}

/** Activate the cached deployment before reloading; reloading the old controller
 * would simply serve the old precached index again. */
export async function activateWebUpdate(): Promise<void> {
  if (!await webUpdateReady() || !readyWorker) throw new Error('No cached deployment ready')
  const worker = readyWorker
  await new Promise<void>((resolve) => {
    const changed = () => {
      if (navigator.serviceWorker.controller !== worker) return
      clearTimeout(timer)
      navigator.serviceWorker.removeEventListener('controllerchange', changed)
      resolve()
    }
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', changed)
      // SKIP_WAITING cannot be undone; reload also recovers a missed event.
      resolve()
    }, 8000)
    navigator.serviceWorker.addEventListener('controllerchange', changed)
    worker.postMessage({ type: 'SKIP_WAITING' })
  })
  reloadOnce()
}
