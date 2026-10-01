import type { VNode } from 'preact'

/** Minimal markdown for coach replies.
 *
 *  Deliberately not a full parser, and deliberately not `innerHTML` — it builds VNodes,
 *  so nothing a model returns can inject markup. It covers what an LLM actually emits in
 *  prose: headings, emphasis, inline code, fenced code, bullet and numbered lists, pipe
 *  tables, horizontal rules and links. Anything it doesn't recognise falls through as
 *  literal text, which is the behaviour the app had for everything before this. */

// Order matters: `**` has to be tried before `*`.
const INLINE_SRC =
  '(\\*\\*|__)(?=\\S)([\\s\\S]*?\\S)\\1' + // bold
  '|\\*(?=\\S)([^*\\n]*?\\S)\\*' + // italic — single-line, so it can't swallow a bold run
  '|~~(?=\\S)([\\s\\S]*?\\S)~~' + // strikethrough
  '|`([^`\\n]+)`' + // inline code
  '|\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)' // link, http(s) only

const HEADING = /^(#{1,6})\s+(.*)$/
const FENCE = /^\s*```+\s*\S*\s*$/
const FENCE_END = /^\s*```+\s*$/
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const BULLET = /^(\s*)(?:[-*•]|\d+[.)])\s+(.*)$/
const ORDERED = /^\s*\d/
const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/

/** A fresh regex per call: `inline` recurses, and a shared `lastIndex` would corrupt the
 *  enclosing scan. */
function inline(text: string): (VNode | string)[] {
  const re = new RegExp(INLINE_SRC, 'g')
  const out: (VNode | string)[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = out.length
    if (m[2] != null) out.push(<strong key={key}>{inline(m[2])}</strong>)
    else if (m[3] != null) out.push(<em key={key}>{inline(m[3])}</em>)
    else if (m[4] != null) out.push(<s key={key}>{inline(m[4])}</s>)
    else if (m[5] != null) out.push(<code key={key} class="md-code">{m[5]}</code>)
    else
      out.push(
        <a key={key} class="md-link" href={m[7]} target="_blank" rel="noopener noreferrer">
          {m[6]}
        </a>,
      )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

export function renderMarkdown(src: string): VNode[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: VNode[] = []
  let i = 0

  /** A table only starts where the next line is the `|---|---|` separator, so ordinary
   *  prose containing a pipe stays prose. */
  const isTableHead = (n: number) =>
    n + 1 < lines.length && lines[n].includes('|') && lines[n + 1].includes('-') && TABLE_SEP.test(lines[n + 1])

  const startsBlock = (n: number) =>
    HEADING.test(lines[n]) || FENCE.test(lines[n]) || HR.test(lines[n]) || BULLET.test(lines[n]) || isTableHead(n)

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const key = out.length

    if (FENCE.test(line)) {
      i++
      const body: string[] = []
      while (i < lines.length && !FENCE_END.test(lines[i])) body.push(lines[i++])
      if (i < lines.length) i++
      out.push(
        <pre key={key} class="md-pre">
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }

    if (HR.test(line)) {
      out.push(<hr key={key} class="md-hr" />)
      i++
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      const level = Math.min(heading[1].length, 3)
      out.push(
        <div key={key} class={`md-h md-h${level}`}>
          {inline(heading[2].trim())}
        </div>,
      )
      i++
      continue
    }

    if (isTableHead(i)) {
      const head = splitRow(lines[i])
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]))
      out.push(
        <div key={key} class="md-table-wrap">
          <table class="md-table">
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    if (BULLET.test(line)) {
      const ordered = ORDERED.test(line)
      const items: { indent: number; text: string }[] = []
      for (let m = lines[i]?.match(BULLET); m; m = lines[i]?.match(BULLET)) {
        items.push({ indent: m[1].length, text: m[2] })
        i++
      }
      const lis = items.map((it, n) => (
        <li key={n} class={it.indent >= 2 ? 'md-sub' : undefined}>
          {inline(it.text)}
        </li>
      ))
      out.push(
        ordered ? (
          <ol key={key} class="md-list">
            {lis}
          </ol>
        ) : (
          <ul key={key} class="md-list">
            {lis}
          </ul>
        ),
      )
      continue
    }

    // Paragraph: the current line plus every following line that isn't blank and doesn't
    // open a block of its own. Newlines inside it survive via `white-space: pre-wrap`.
    const para: string[] = [lines[i++]]
    while (i < lines.length && lines[i].trim() && !startsBlock(i)) para.push(lines[i++])
    out.push(
      <p key={key} class="md-p">
        {inline(para.join('\n'))}
      </p>,
    )
  }

  return out
}
