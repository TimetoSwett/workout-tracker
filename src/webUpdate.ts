/** A waiting service worker has finished caching an actual deployment from this
 * origin. A GitHub release alone is never evidence that web assets are ready. */
let readyWorker: ServiceWorker | null = null

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
  await new Promise<void>((resolve, reject) => {
    const changed = () => {
      if (navigator.serviceWorker.controller !== worker) return
      clearTimeout(timer)
      navigator.serviceWorker.removeEventListener('controllerchange', changed)
      resolve()
    }
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', changed)
      reject(new Error('Activation timed out'))
    }, 8000)
    navigator.serviceWorker.addEventListener('controllerchange', changed)
    worker.postMessage({ type: 'SKIP_WAITING' })
  })
  location.reload()
}
