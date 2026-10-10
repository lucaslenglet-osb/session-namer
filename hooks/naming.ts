// Pure logic (no `$`): project code, name format, Haiku prompt and parsing.

export type Parts = {
  type?: string // bug, us, pr, feat, ...
  id?: string // 1234, ABC-12, ...
  kind?: string // f, b, cli, mod, script, ...
  desc: string // 2 to 5 words
}

export type Verdict = {
  isSameSubject: boolean
  suggestions: Parts[]
}

/** Project code of 3 to 5 characters taken from the folder name: ClaudeMods → clmod. */
export function projectCode(cwd: string): string {
  const base = cwd.replace(/\/+$/, '').split('/').pop() ?? ''
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase())

  const [first, second] = words
  if (first === undefined) return 'proj'
  if (second === undefined) return first.slice(0, 5)
  if (words.length === 2) return first.slice(0, 2) + second.slice(0, 3)

  return words.map(w => w.charAt(0)).join('').slice(0, 5)
}

export const DEFAULT_TEMPLATE = '{type:L}-{id}/{project:L:,5}-{kind:L}: {desc:L:w2,5}'

export const FIELDS = ['type', 'id', 'project', 'kind', 'desc'] as const
export type Field = (typeof FIELDS)[number]

/**
 * A template field: `{name:mod:mod|fallback}`.
 *   U / L / C           UPPERCASE, lowercase, Capitalized
 *   K / S               words joined by - (kebab) or _ (snake)
 *   3  2,5  ,5  3,      length in characters: exact, min-max, max, min
 *   …_0                 padding character, on the left (4,_0: 42 → 0042)
 *   w2,5  w,5  w3       number of words (same syntax, no padding)
 *   [bug,us,pr]         allowed values; any other value counts as empty
 *   |gen                value used when the field is empty (otherwise it disappears)
 */
export type Spec = {
  field: Field
  cases: ('U' | 'L' | 'C' | 'K' | 'S')[]
  chars?: { min?: number; max?: number; pad?: string }
  words?: { min?: number; max?: number }
  allowed?: string[]
  fallback?: string
}

const FIELD = /\{([a-z]+)((?::[^:{}|]*)*)(?:\|([^{}]*))?\}/g
const RANGE = /^(\d*)(,?)(\d*)(?:_(.))?$/

function range(text: string): { min?: number; max?: number; pad?: string } | undefined {
  const m = RANGE.exec(text)
  if (!m || (m[1] === '' && m[3] === '')) return undefined
  const [, a = '', comma, b = '', pad] = m
  const min = a === '' ? undefined : Number(a)
  const max = comma ? (b === '' ? undefined : Number(b)) : min
  return { min, max, pad }
}

export function parseSpec(name: string, mods: string, fallback: string | undefined): Spec | undefined {
  if (!(FIELDS as readonly string[]).includes(name)) return undefined
  const spec: Spec = { field: name as Field, cases: [], fallback: fallback?.trim() || undefined }
  for (const mod of mods.split(':').map(m => m.trim()).filter(Boolean)) {
    if (/^[ULCKS]$/.test(mod)) spec.cases.push(mod as Spec['cases'][number])
    else if (mod.startsWith('[') && mod.endsWith(']'))
      spec.allowed = mod.slice(1, -1).split(',').map(v => v.trim()).filter(Boolean)
    else if (mod.startsWith('w')) spec.words = range(mod.slice(1))
    else spec.chars = range(mod)
    // An unknown modifier is ignored: the name stays readable rather than broken.
  }
  return spec
}

/** The template's fields, in order (the same field may appear twice). */
export function specs(template: string): Spec[] {
  return [...template.matchAll(FIELD)].flatMap(m => parseSpec(m[1] ?? '', m[2] ?? '', m[3]) ?? [])
}

// Keeps letters (accents included), digits and a few characters useful in ids.
const clean = (s: string | undefined) =>
  (s ?? '').replace(/[^\p{L}\p{N}#.\- ]+/gu, '').replace(/\s+/g, ' ').trim()

// Space padding must survive the final whitespace cleanup.
const PAD_SPACE = '\u0000'

export function applySpec(spec: Spec, raw: string): string {
  let v = raw
  if (spec.allowed && !spec.allowed.some(a => a.toLowerCase() === v.toLowerCase())) v = ''
  else if (spec.allowed) v = spec.allowed.find(a => a.toLowerCase() === v.toLowerCase()) ?? v
  if (v === '') v = spec.fallback ?? ''
  if (v === '') return ''

  if (spec.words?.max !== undefined) v = v.split(' ').slice(0, spec.words.max).join(' ')
  for (const c of spec.cases) {
    if (c === 'U') v = v.toUpperCase()
    if (c === 'L') v = v.toLowerCase()
    if (c === 'C') v = v.charAt(0).toUpperCase() + v.slice(1)
    if (c === 'K') v = v.replace(/ /g, '-')
    if (c === 'S') v = v.replace(/ /g, '_')
  }
  const chars = spec.chars
  if (chars?.max !== undefined) v = [...v].slice(0, chars.max).join('').trimEnd()
  if (chars?.min !== undefined && [...v].length < chars.min) {
    const fill = (chars.pad ?? PAD_SPACE).repeat(chars.min - [...v].length)
    v = chars.pad === undefined ? v + fill : fill + v
  }
  return v
}

const OPENERS = /[([{<]/

/**
 * Fills the template. An empty field disappears together with a neighbouring
 * separator: the one before it if it follows a filled field and does not open a
 * parenthesis/bracket, otherwise the one after it. Empty pairs and orphan
 * openers are then removed.
 *   {type:L}-{id}/{project}-{kind}: {desc}  →  bug-1234/clmod-mod: init spec
 *                                           →  clmod: init spec
 */
export function formatName(template: string, project: string, p: Parts): string {
  const values: Record<Field, string> = {
    type: clean(p.type).replace(/ /g, ''),
    id: clean(p.id).replace(/ /g, ''),
    project,
    kind: clean(p.kind).replace(/ /g, ''),
    desc: clean(p.desc).split(' ').slice(0, 12).join(' '),
  }

  const out: { text: string; isField: boolean }[] = []
  let skipNext = false
  const literal = (text: string) => {
    if (text === '') return
    if (skipNext) skipNext = false
    else out.push({ text, isField: false })
  }

  let at = 0
  for (const m of template.matchAll(FIELD)) {
    literal(template.slice(at, m.index))
    at = m.index + m[0].length
    const spec = parseSpec(m[1] ?? '', m[2] ?? '', m[3])
    if (spec === undefined) {
      literal(m[0])
      continue
    }
    const value = applySpec(spec, values[spec.field])
    if (value !== '') {
      out.push({ text: value, isField: true })
      skipNext = false
      continue
    }
    const prev = out.at(-1)
    const hasFieldBefore = out.some(t => t.isField)
    if (prev && !prev.isField && hasFieldBefore && !OPENERS.test(prev.text)) out.pop()
    else skipNext = true
  }
  literal(template.slice(at))

  let name = out.map(t => t.text).join('')
  for (let i = 0; i < 3; i++) name = name.replace(/\s*(\(\s*\)|\[\s*\]|\{\s*\}|<\s*>)/g, '')
  return name
    .replace(/\s*[([{<]\s*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-/:#|_.]+|[\s\-/:#|_.]+$/g, '')
    .replaceAll(PAD_SPACE, ' ')
}

const between = (r: { min?: number; max?: number }, unit: string) =>
  r.min !== undefined && r.min === r.max
    ? `exactly ${r.min} ${unit}`
    : [r.min !== undefined && `at least ${r.min} ${unit}`, r.max !== undefined && `at most ${r.max} ${unit}`]
        .filter(Boolean)
        .join(' and ')

/** The template's constraints, told to Haiku so it respects them without being truncated. */
export function constraints(template: string): string {
  const lines = specs(template)
    .filter(s => s.field !== 'project')
    .map(s => {
      const parts = [
        s.allowed && `pick one of: ${s.allowed.join(', ')} (otherwise leave empty)`,
        s.words && between(s.words, 'words'),
        s.chars && s.chars.max !== undefined && `at most ${s.chars.max} characters`,
      ].filter(Boolean)
      return parts.length ? `- ${s.field}: ${parts.join('; ')}` : ''
    })
    .filter(Boolean)
  return [...new Set(lines)].join('\n')
}

export const SYSTEM = `You name a developer's work sessions.
You provide fields; the program assembles them according to the FORMAT given in the request and adds the project code itself.
- type (optional): nature of the item being worked on, one short lowercase word (bug, us, pr, feat, task, doc...). ONLY if it is explicit in the conversation.
- id (optional): identifier of that item (ticket number, PR number...). ONLY if it appears verbatim in the conversation. Never invent an id.
- kind (optional): kind of project, short (f = front, b = back, cli, mod, script, lib, api, infra...). Only if it is clear.
- desc (required): 2 to 5 words in English, lowercase, action verb first, what is being DONE (e.g. "init spec", "update spec", "plan tests", "implement back", "fix login redirect").
When in doubt, leave an optional field empty rather than guessing.
The FIELD CONSTRAINTS in the request take precedence over everything else (allowed values, number of words, length).
If the request lists ALREADY PROPOSED names, the user rejected them: give 3 new variants that differ from them in wording (same fields rules).
If the request contains USER INSTRUCTIONS, they take precedence over the rules above (language, vocabulary, length...), but never over the response format below.

Reply ONLY with a JSON object, with no text around it:
{"sameSubject": true|false, "suggestions": [{"type": "", "id": "", "kind": "", "desc": ""}, ...]}
- suggestions: exactly 3 distinct variants, best first.
- sameSubject: true if the conversation is still about the same work as the CURRENT NAME provided (a neighbouring step of the same work counts as the same subject only if the description would still be accurate); false if it has changed or if there is no current name.`

/** Keeps the first message and the end of the conversation, within a character budget. */
export function transcript(
  messages: readonly { role: 'user' | 'assistant'; text: string }[],
  budget = 12000,
  perMessage = 800,
): string {
  const lines = messages
    .filter(m => m.text.trim() !== '')
    .map(m => {
      const text = m.text.trim()
      const cut = text.length > perMessage ? text.slice(0, perMessage) + ' […]' : text
      return `${m.role === 'user' ? 'USER' : 'CLAUDE'}: ${cut}`
    })
  const [first, ...rest] = lines
  if (first === undefined) return ''

  const tail: string[] = []
  let size = first.length
  for (const line of [...rest].reverse()) {
    if (size + line.length > budget) break
    size += line.length
    tail.unshift(line)
  }
  const skipped = rest.length - tail.length
  return [first, ...(skipped > 0 ? [`[… ${skipped} messages omitted …]`] : []), ...tail].join('\n\n')
}

export type Settings = { template: string; rules: string }

export function prompt(
  convo: string,
  project: string,
  baseline: string | null,
  settings: Settings,
  avoid: readonly string[] = [],
): string {
  const rules = settings.rules.trim()
  const limits = constraints(settings.template)
  return `FORMAT: ${settings.template}
${limits ? `FIELD CONSTRAINTS (take precedence):\n${limits}\n` : ''}Project code (already set): ${project}
CURRENT NAME: ${baseline ?? '(none)'}
${avoid.length > 0 ? `ALREADY PROPOSED (give different ones):\n${avoid.map(n => `- ${n}`).join('\n')}\n` : ''}${rules ? `\nUSER INSTRUCTIONS:\n${rules}\n` : ''}
<conversation>
${convo}
</conversation>`
}

/** Reads Haiku's JSON reply; undefined if it is unusable. */
export function parseVerdict(text: string): Verdict | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as {
      sameSubject?: unknown
      suggestions?: unknown
    }
    const suggestions = (Array.isArray(raw.suggestions) ? raw.suggestions : [])
      .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
      .map(s => ({
        type: typeof s.type === 'string' ? s.type : undefined,
        id: typeof s.id === 'string' ? s.id : undefined,
        kind: typeof s.kind === 'string' ? s.kind : undefined,
        desc: typeof s.desc === 'string' ? s.desc : '',
      }))
      .filter(s => clean(s.desc) !== '')
    if (suggestions.length === 0) return undefined
    return { isSameSubject: raw.sameSubject === true, suggestions }
  } catch {
    return undefined
  }
}

/** Formatted names, without duplicates, at most 3. */
export function names(template: string, project: string, v: Verdict): string[] {
  return [...new Set(v.suggestions.map(p => formatName(template, project, p)))].slice(0, 3)
}

const SAMPLES: { label: string; parts: Parts }[] = [
  { label: 'everything found', parts: { type: 'bug', id: '1234', kind: 'f', desc: 'fix login redirect' } },
  { label: 'no ticket', parts: { kind: 'cli', desc: 'plan tests' } },
  { label: 'description only', parts: { desc: 'init spec' } },
]

export type HelpInput = {
  template: string
  rules: string
  project: string
  isProjectForced: boolean
  /** The template that was entered, when it was rejected (no {desc}). */
  rejectedTemplate?: string
  total?: typeof NO_SPEND
  isCostShown?: boolean
  isStopped?: boolean
}

/** The /rs help manual, with a preview using the current settings. */
export function helpText(h: HelpInput): string {
  const preview = SAMPLES.map(s => `  ${s.label.padEnd(18)} → ${formatName(h.template, h.project, s.parts)}`)
  return [
    'After each Claude reply, Haiku reads the conversation and suggests 3 session names',
    'in a band above the prompt. Click one (or ctrl+x tab, then 1-3) to rename; r rerolls',
    '(3 different names), x dismisses, s stops the suggestions for this session.',
    "Once named, it stays quiet until the topic changes. /rs asks for suggestions right now",
    '(different ones if the band is shown). /rs stop and /rs start turn the automatic',
    `suggestions off and on for this session (now: ${h.isStopped === true ? 'stopped' : 'on'}).`,
    '',
    'SETTINGS  (/config, search "session name")',
    `  Session name format          ${h.template}`,
    ...(h.rejectedTemplate !== undefined
      ? [`    ⚠ "${h.rejectedTemplate}" has no {desc} field, so the default format is used.`]
      : []),
    `  Session name rules for Haiku ${h.rules || '(none: default rules)'}`,
    `  Session name project code    ${h.isProjectForced ? h.project : `(automatic: ${h.project}, from the folder name)`}`,
    `  Session name cost display    ${h.isCostShown === false ? 'off' : 'on'}`,
    '',
    'PREVIEW  (current settings, sample values)',
    ...preview,
    '',
    'FORMAT  Text is kept as typed; {field} is replaced by a value Haiku finds in the conversation.',
    '  {type}     kind of work item: bug, us, pr, feat...   (only if stated)',
    '  {id}       its ticket / PR number                    (only if stated, never invented)',
    '  {project}  project code                              (always filled)',
    '  {kind}     kind of project: f, b, cli, mod, script... (only if clear)',
    '  {desc}     what you are doing, e.g. "init spec"      (always filled, required)',
    '  An empty field disappears together with the separator next to it.',
    '',
    'FIELD OPTIONS  {field:option:option|fallback}, combinable',
    '  U  L  C        UPPER, lower, Capitalized          {type:U}     → BUG',
    '  K  S           kebab-case, snake_case             {desc:K}     → init-spec',
    '  3  2,5  ,5  3, length in characters: exact,       {type:3}     → fea',
    '                 min-max, max, min (cut / padded)',
    '  _x after a length: pad with x on the left         {id:4,_0}    → 0042',
    '  w2,5  w,3      number of words                    {desc:w,3}',
    '  [a,b,c]        allowed values, anything else = empty  {type:[bug,us,pr]}',
    '  |text          value used when the field is empty {kind|gen}   → gen',
    'Haiku is told about the limits and allowed values, so it picks words that fit.',
    '',
    'RULES FOR HAIKU  free text, overrides the default rules, e.g.',
    '  "description in French; allowed types: feat, fix, chore; never use {kind}"',
    '',
    'COST  one Haiku call per Claude reply, low effort, ≤ ~12,000 characters of conversation.',
    '  Estimated at Claude Haiku 5.5 API rates ($0.10 / $0.50 per million input / output tokens);',
    '  on a Claude subscription it counts toward your usage limits instead.',
    `  This session: ${h.total ? spendText(h.total, true) : 'no call yet'}`,
    `  Shown in the band and /rs: ${h.isCostShown === false ? 'no' : 'yes'} (Session name cost display)`,
  ].join('\n')
}

// Claude Haiku 5.5 API prices in $ per million tokens (prompts ≤ 100K tokens).
// Cache: reads cost 0.1× and writes 1.25× the input price (the mod marks nothing for caching).
const PRICE = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const NO_SPEND = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function addUsage<S extends typeof NO_SPEND>(s: S, u: Usage): typeof NO_SPEND {
  return {
    calls: s.calls + 1,
    input: s.input + u.input_tokens,
    output: s.output + u.output_tokens,
    cacheRead: s.cacheRead + u.cache_read_input_tokens,
    cacheWrite: s.cacheWrite + u.cache_creation_input_tokens,
  }
}

export function dollars(s: typeof NO_SPEND): number {
  return (
    (s.input * PRICE.input + s.output * PRICE.output + s.cacheRead * PRICE.cacheRead + s.cacheWrite * PRICE.cacheWrite) /
    1e6
  )
}

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const usd = (x: number) => (x === 0 ? '$0' : x < 0.0001 ? '<$0.0001' : `$${Number(x.toPrecision(2))}`)

/** "≈$0.00037 (2.1k tokens)", plus ", 7 calls" for a total. */
export function spendText(s: typeof NO_SPEND, isTotal = false): string {
  const all = s.input + s.output + s.cacheRead + s.cacheWrite
  const calls = isTotal ? `, ${s.calls} call${s.calls === 1 ? '' : 's'}` : ''
  return `≈${usd(dollars(s))} (${tokens(all)} tokens${calls})`
}
