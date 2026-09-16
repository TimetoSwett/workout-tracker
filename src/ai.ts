import type { AISettings } from './types'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export async function aiChat(ai: AISettings, system: string, messages: ChatMessage[]): Promise<string> {
  if (ai.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`)
    }
    const data = await res.json()
    const text = (data.content as { type: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')
    return text
  }

  const base = (ai.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  // The API key goes in a bearer header; never send it over a cleartext URL.
  if (!/^https:\/\//i.test(base)) throw new Error('Base URL must start with https://')
  const res = await fetch(`${base}/chat/completions`, {
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
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API error ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}
