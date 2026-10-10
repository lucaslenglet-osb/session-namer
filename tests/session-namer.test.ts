import { expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput, On, RenderElement } from 'claude-code'

import { addUsage, constraints, DEFAULT_TEMPLATE, dollars, formatName, NO_SPEND, spendText, parseVerdict, projectCode, transcript } from '../hooks/naming'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

const HAIKU = JSON.stringify({
  sameSubject: false,
  suggestions: [
    { type: 'feat', id: '', kind: 'mod', desc: 'implement session namer' },
    { type: '', id: '', kind: 'mod', desc: 'init spec' },
    { type: 'bug', id: '42', kind: '', desc: 'Fix Band Render!' },
  ],
})

test('projectCode takes 3 to 5 characters from the folder name', () => {
  expect(projectCode('/home/lucas/Dev/ClaudeMods')).toBe('clmod')
  expect(projectCode('/x/prompt-optimizer')).toBe('propt')
  expect(projectCode('/x/api')).toBe('api')
  expect(projectCode('/x/frontend/')).toBe('front')
  expect(projectCode('/x/my_cool_web_app')).toBe('mcwa')
})

test('formatName: default template, empty fields take their separator with them', () => {
  const f = (p: Parameters<typeof formatName>[2]) => formatName(DEFAULT_TEMPLATE, 'clmod', p)
  expect(f({ type: 'bug', id: '1234', kind: 'mod', desc: 'init spec' })).toBe('bug-1234/clmod-mod: init spec')
  expect(f({ kind: 'cli', desc: 'plan tests' })).toBe('clmod-cli: plan tests')
  expect(f({ desc: 'plan tests' })).toBe('clmod: plan tests')
  expect(f({ type: 'pr', desc: 'review the big thing' })).toBe('pr/clmod: review the big thing')
  expect(f({ id: 'ABC-12', desc: 'fix login' })).toBe('ABC-12/clmod: fix login')
  expect(f({ desc: 'café menu update!' })).toBe('clmod: café menu update')
})

test('formatName: custom template with parentheses', () => {
  const t = '[{project}] {desc} ({type} #{id})'
  expect(formatName(t, 'cm', { type: 'feat', id: '42', desc: 'add login' })).toBe('[cm] add login (feat #42)')
  expect(formatName(t, 'cm', { type: 'feat', desc: 'add login' })).toBe('[cm] add login (feat)')
  expect(formatName(t, 'cm', { id: '42', desc: 'add login' })).toBe('[cm] add login (42)')
  expect(formatName(t, 'cm', { desc: 'add login' })).toBe('[cm] add login')
  expect(formatName('{desc} | {project}', 'cm', { desc: 'add login' })).toBe('add login | cm')
})

test('modifiers: case, kebab/snake', () => {
  const p = { type: 'Feat', desc: 'init the spec' }
  expect(formatName('{type:U} {desc:C}', 'cm', p)).toBe('FEAT Init the spec')
  expect(formatName('{type:L}/{desc:K}', 'cm', p)).toBe('feat/init-the-spec')
  expect(formatName('{desc:S:U}', 'cm', p)).toBe('INIT_THE_SPEC')
})

test('modifiers: lengths in characters and padding', () => {
  expect(formatName('{type:3}', 'cm', { type: 'feat', desc: 'x' })).toBe('fea')
  expect(formatName('{type:,2}', 'cm', { type: 'feat', desc: 'x' })).toBe('fe')
  expect(formatName('{id:4,_0}', 'cm', { id: '42', desc: 'x' })).toBe('0042')
  expect(formatName('{id:4,_0}', 'cm', { id: '12345', desc: 'x' })).toBe('12345')
  expect(formatName('{type:5}|{desc}', 'cm', { type: 'us', desc: 'x' })).toBe('us   |x')
  expect(formatName('[{type:2,4}] {desc}', 'cm', { type: 'bugfix', desc: 'x' })).toBe('[bugf] x')
})

test('modifiers: words, allowed values, fallback value', () => {
  expect(formatName('{desc:w,2}', 'cm', { desc: 'one two three' })).toBe('one two')
  const t = '{type:U:[bug,us,pr]}-{id}/{project}: {desc}'
  expect(formatName(t, 'cm', { type: 'BUG', id: '7', desc: 'x' })).toBe('BUG-7/cm: x')
  expect(formatName(t, 'cm', { type: 'feat', id: '7', desc: 'x' })).toBe('7/cm: x')
  expect(formatName('{project}-{kind|gen}: {desc}', 'cm', { desc: 'x' })).toBe('cm-gen: x')
  expect(formatName('{type:[bug]|task}: {desc}', 'cm', { type: 'feat', desc: 'x' })).toBe('task: x')
})

test('unknown modifiers are ignored, unknown fields are left as they are', () => {
  expect(formatName('{type:Z:??}-{nope}: {desc}', 'cm', { type: 'bug', desc: 'x' })).toBe('bug-{nope}: x')
})

test("the template's constraints are told to Haiku", () => {
  const c = constraints('{type:U:[bug,us]:,3}-{id:4,_0}/{project:,5}: {desc:w2,5}')
  expect(c).toContain('- type: pick one of: bug, us (otherwise leave empty); at most 3 characters')
  expect(c).toContain('- desc: at least 2 words and at most 5 words')
  expect(c).not.toContain('project')
  expect(constraints('{desc:w3}')).toBe('- desc: exactly 3 words')
})

test('parseVerdict tolerates text around the JSON and rejects the rest', () => {
  const v = parseVerdict('Here you go:\n' + HAIKU + '\nDone')
  expect(v?.isSameSubject).toBe(false)
  expect(v?.suggestions).toHaveLength(3)
  expect(parseVerdict('no json')).toBeUndefined()
  expect(parseVerdict('{"suggestions": [{"desc": ""}]}')).toBeUndefined()
})

test('transcript keeps the first message and the end within the budget', () => {
  const msgs = Array.from({ length: 50 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `message ${i} `.repeat(20),
  }))
  const t = transcript(msgs, 2000)
  expect(t.startsWith('USER: message 0')).toBe(true)
  expect(t).toContain('messages omitted')
  expect(t).toContain('message 49')
  expect(t.length < 2600).toBe(true)
})

/** What sits beneath the mod: the conversation, the folder, Haiku, /rename, the empty band. */
function world(on: On, haiku: () => string) {
  const asked: string[] = []
  const renamed: string[] = []
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'I want a mod that renames sessions', toolUses: [] },
      { role: 'assistant', text: 'Good idea, here is a plan.', toolUses: [] },
    ],
  }))
  on('session.cwd', () => ({ value: '/home/lucas/Dev/ClaudeMods' }))
  on('model.complete', ($, e) => {
    asked.push(e.prompt)
    return { value: { isAnswered: true, text: haiku(), usage: USAGE } }
  })
  on('command.run', { command: 'rename' }, ($, e) => {
    renamed.push(e.args)
    return { text: 'ok' }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as unknown as RenderElement)
  return { asked, renamed }
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as unknown as Pick<CommandRunInput, 'origin' | 'presentation'>
const TURN = { answer: 'Fait.', durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' } as const

test('/rs shows 3 names, a click renames and hides the band', async ($, on) => {
  const { asked, renamed } = world(on, () => HAIKU)

  const out = await $.command.run({ command: 'rs', args: '', ...RUN })
  expect(out.text).toContain('feat/clmod-mod: implement session namer')
  expect(out.text).toContain('bug-42/clmod: fix band render')
  expect(asked[0]).toContain('CURRENT NAME: (none)')
  expect(asked[0]).toContain('- desc: at least 2 words and at most 5 words')

  const ui = await $.ui.mount({ plugin: 'session-namer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(4)
  await ui.press({ key: 'pick-0' })
  expect(renamed).toEqual(['feat/clmod-mod: implement session namer'])
  expect(await ui.find({ key: 'pick-0' })).toBeUndefined()
})

test('after each reply: suggests, then stays quiet until the subject changes', async ($, on) => {
  const clock = mock.clock(on)
  let same = false
  const { asked } = world(on, () => HAIKU.replace('"sameSubject":false', `"sameSubject":${same}`))
  const band = () =>
    $.ui.mount({ plugin: 'session-namer', surface: 'desktop', component: 'AbovePrompt', props: BAND })

  // 1st turn, no name yet: the band appears.
  await $.turn.complete(TURN)
  await clock.advance(1)
  expect(asked).toHaveLength(1)
  expect(await (await band()).find({ key: 'pick-2' })).toBeDefined()

  // A name is picked.
  await (await band()).press({ key: 'pick-1' })
  expect(await (await band()).find({ key: 'pick-0' })).toBeUndefined()

  // Same subject: Haiku is consulted but nothing is shown.
  same = true
  await $.turn.complete(TURN)
  await clock.advance(1)
  expect(asked).toHaveLength(2)
  expect(asked[1]).toContain('CURRENT NAME: clmod-mod: init spec')
  expect(await (await band()).find({ key: 'pick-0' })).toBeUndefined()

  // The subject changes: the band comes back.
  same = false
  await $.turn.complete(TURN)
  await clock.advance(1)
  expect(await (await band()).find({ key: 'pick-0' })).toBeDefined()

  // "Dismiss" hides it too.
  await (await band()).press({ key: 'dismiss' })
  expect(await (await band()).find({ key: 'pick-0' })).toBeUndefined()
})

test('subagent turns and interrupted turns do not call Haiku', async ($, on) => {
  const clock = mock.clock(on)
  const { asked } = world(on, () => HAIKU)
  await $.turn.complete({ ...TURN, agentId: 'sub' })
  await $.turn.complete({ ...TURN, isAborted: true, reason: 'aborted' })
  await clock.advance(1)
  expect(asked).toHaveLength(0)
})

test(
  'options change the format, the project code and the instructions',
  { options: { template: '[{project}] {desc}', project: 'cm', rules: 'descriptions in French' } },
  async ($, on) => {
    const { asked } = world(on, () => HAIKU)
    const out = await $.command.run({ command: 'rs', args: '', ...RUN })
    expect(out.text).toContain('1. [cm] implement session namer')
    expect(asked[0]).toContain('FORMAT: [{project}] {desc}')
    expect(asked[0]).not.toContain('FIELD CONSTRAINTS')
    expect(asked[0]).toContain('USER INSTRUCTIONS:\ndescriptions in French')
  },
)

test('a template without {desc} falls back to the default', { options: { template: '{project}' } }, async ($, on) => {
  world(on, () => HAIKU)
  const out = await $.command.run({ command: 'rs', args: '', ...RUN })
  expect(out.text).toContain('1. feat/clmod-mod: implement session namer')
})

test('/rs help explains and shows a preview with the current config', async ($, on) => {
  world(on, () => HAIKU)
  const out = await $.command.run({ command: 'rs', args: 'help', ...RUN })
  expect(out.text).toContain('Session name format          {type:L}-{id}/{project:L:,5}-{kind:L}: {desc:L:w2,5}')
  expect(out.text).toContain('(automatic: clmod, from the folder name)')
  expect(out.text).toContain('everything found   → bug-1234/clmod-f: fix login redirect')
  expect(out.text).toContain('description only   → clmod: init spec')
})

test('/rs help reports a rejected format', { options: { template: '{project}', project: 'cm' } }, async ($, on) => {
  world(on, () => HAIKU)
  const out = await $.command.run({ command: 'rs', args: 'help', ...RUN })
  expect(out.text).toContain('"{project}" has no {desc} field, so the default format is used.')
  expect(out.text).toContain('Session name project code    cm')
})

test('the README example', () => {
  const t = '[{project}] {desc:C:w,5} ({type:U:[FEAT,FIX,CHORE]} #{id:4,_0})'
  expect(formatName(t, 'clmod', { type: 'fix', id: '42', desc: 'fix login redirect' })).toBe(
    '[clmod] Fix login redirect (FIX #0042)',
  )
})

test('cost: Haiku 5.5 price and formatting', () => {
  const one = addUsage(NO_SPEND, { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  expect(Math.abs(dollars(one) - 0.00025) < 1e-12).toBe(true)
  expect(spendText(one)).toBe('≈$0.00025 (2.1k tokens)')
  const two = addUsage(one, { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  expect(spendText(two, true)).toBe('≈$0.0005 (4.2k tokens, 2 calls)')
  expect(spendText(NO_SPEND, true)).toBe('≈$0 (0 tokens, 0 calls)')
})

test('the cost is shown in /rs, the band and /rs help, and counts every call', async ($, on) => {
  const clock = mock.clock(on)
  let same = false
  world(on, () => HAIKU.replace('"sameSubject":false', `"sameSubject":${same}`))

  const out = await $.command.run({ command: 'rs', args: '', ...RUN })
  expect(out.text).toContain('Cost: ≈<$0.0001 (2 tokens) · this session: ≈<$0.0001 (2 tokens, 1 call)')

  const ui = await $.ui.mount({ plugin: 'session-namer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  expect(texts).toContain('session ≈<$0.0001 (2 tokens, 1 call)')

  // A call that changes nothing on screen still counts in the total.
  await ui.press({ key: 'pick-0' })
  same = true
  await $.turn.complete(TURN)
  await clock.advance(1)
  const help = await $.command.run({ command: 'rs', args: 'help', ...RUN })
  expect(help.text).toContain('This session: ≈<$0.0001 (4 tokens, 2 calls)')
})

test('the cost display can be turned off', { options: { showCost: false } }, async ($, on) => {
  world(on, () => HAIKU)
  const out = await $.command.run({ command: 'rs', args: '', ...RUN })
  expect(out.text).not.toContain('Cost:')
  const ui = await $.ui.mount({ plugin: 'session-namer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  expect(texts).not.toContain('session ≈')
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(4)
  const help = await $.command.run({ command: 'rs', args: 'help', ...RUN })
  expect(help.text).toContain('Session name cost display    off')
  expect(help.text).toContain('This session: ≈<$0.0001 (2 tokens, 1 call)')
})
