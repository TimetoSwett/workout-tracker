import type { AISettings } from './types'
import { getState, subscribe } from './store'
import { AIDisabled, aiFeaturesEnabled } from './aiGate'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Wall-clock cap on a single provider call. Generous, because a long review with a
 *  full workout log attached is legitimately slow — the point is that a provider which
 *  accepts the connection and never answers can no longer hang the UI forever. */
export const AI_TIMEOUT_MS = 120_000

export interface AIChatOptions {
  /** Aborts the call. The rejection is an `AICancelled`, so a deliberate cancel can be
   *  told apart from a real failure and not shown as an error. */
  signal?: AbortSignal
  /** Overrides `AI_TIMEOUT_MS` for this call. */
  timeoutMs?: number
}

/** Rejection produced when the caller aborts via `AIChatOptions.signal`. */
export class AICancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'AICancelled'
  }
}

export function isCancelled(e: unknown): boolean {
  return e instanceof Error && e.name === 'AICancelled'
}

/** Controllers for provider calls that are currently open, so turning the AI features off
 *  can stop work that is already on the wire instead of only refusing the next call. */
const inFlight = new Set<AbortController>()

/** Aborts every open provider call. An aborted call rejects as `AICancelled`, which the
 *  coach already treats as the board's own doing and does not report as an error. */
export function abortInFlightAI() {
  for (const controller of [...inFlight]) controller.abort()
}

// Watching the store rather than the Settings toggle's click handler means the kill switch
// holds for any path that writes the preference, and the abort reaches calls started from
// a view that has since been unmounted.
subscribe(() => {
  if (!aiFeaturesEnabled(getState().settings)) abortInFlightAI()
})

/** One request under a single abort scope that covers reading the body as well as the
 *  fetch — a provider that sends headers and then stalls mid-body has to time out too.
 *  `label` prefixes the HTTP error so each provider keeps the message it already had. */
async function requestJson(
  url: string,
  init: RequestInit,
  label: string,
  options: AIChatOptions | undefined,
): Promise<any> {
  const caller = options?.signal
  if (caller?.aborted) throw new AICancelled()

  const timeoutMs = options?.timeoutMs ?? AI_TIMEOUT_MS
  const controller = new AbortController()
  inFlight.add(controller)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  caller?.addEventListener('abort', onAbort)

  // Aborting the fetch signal is what stops the request, but the deadline is enforced by
  // racing the whole exchange against it: the reply is only useful if it arrives in time,
  // and this way a body read that stalls can't outlive the cap either.
  const deadline = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      },
      { once: true },
    )
  })

  const exchange = async (): Promise<any> => {
    const res = await fetch(url, { ...init, signal: controller.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${label} ${res.status}: ${body.slice(0, 300)}`)
    }
    return await res.json()
  }

  try {
    return await Promise.race([exchange(), deadline])
  } catch (e) {
    if ((e as { name?: string } | null)?.name === 'AbortError') {
      if (timedOut) {
        throw new Error(
          `No reply from the AI provider after ${Math.max(1, Math.round(timeoutMs / 1000))}s. It may be overloaded — try again.`,
        )
      }
      throw new AICancelled()
    }
    throw e
  } finally {
    clearTimeout(timer)
    inFlight.delete(controller)
    caller?.removeEventListener('abort', onAbort)
  }
}

export async function aiChat(
  ai: AISettings,
  system: string,
  messages: ChatMessage[],
  options?: AIChatOptions,
): Promise<string> {
  // The single network boundary for every AI feature, so the switch does not depend on
  // each call site remembering to ask. Checked against the live store, not a copy the
  // caller captured, so a call queued before the switch flipped still does not go out.
  if (!aiFeaturesEnabled(getState().settings)) throw new AIDisabled()

  if (ai.provider === 'anthropic') {
    const data = await requestJson(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ai.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: ai.model || 'claude-sonnet-4-5',
          max_tokens: 4096,
          system,
          messages,
        }),
      },
      'Anthropic API error',
      options,
    )
    const text = (data.content as { type: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')
    return text
  }

  const base = (ai.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  // The API key goes in a bearer header; never send it over a cleartext URL.
  if (!/^https:\/\//i.test(base)) throw new Error('Base URL must start with https://')
  const data = await requestJson(
    `${base}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model,
        messages: [{ role: 'system', content: system }, ...messages],
        max_tokens: 4096,
      }),
    },
    'API error',
    options,
  )
  return data.choices?.[0]?.message?.content ?? ''
}
