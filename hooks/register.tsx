import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Baseline, Spend, Suggestions } from '../types'
import {
  addUsage,
  DEFAULT_TEMPLATE,
  helpText,
  names,
  NO_SPEND,
  parseVerdict,
  projectCode,
  prompt,
  specs,
  spendText,
  SYSTEM,
  transcript,
} from './naming'
import type { Settings } from './naming'

const suggestions = atom({ plugin: 'session-namer', key: 'suggestions' } as const, [] as Suggestions)
const baseline = atom({ plugin: 'session-namer', key: 'baseline' } as const, null as Baseline)
const lastCall = atom({ plugin: 'session-namer', key: 'lastCall' } as const, null as Spend | null)
const total = atom({ plugin: 'session-namer', key: 'total' } as const, NO_SPEND as Spend)
const isStopped = atom({ plugin: 'session-namer', key: 'isStopped' } as const, false)
const isGenerating = atom({ plugin: 'session-namer', key: 'isGenerating' } as const, false)
const frame = atom({ plugin: 'session-namer', key: 'frame' } as const, 0)

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])

// Mod options (/config); a change reloads the module, so register reads them again.
let settings: Settings = { template: DEFAULT_TEMPLATE, rules: '' }
let forcedProject = ''
let isCostShown = true
let rejectedTemplate: string | undefined

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

// One request to Haiku at a time, automatic or not: each job waits for the previous one.
let queue: Promise<unknown> = Promise.resolve()
const enqueue = <T,>(job: () => Promise<T>): Promise<T> => {
  const run = queue.then(job, job)
  queue = run.catch(() => undefined)
  return run
}
// An automatic request already waiting in the queue: another one adds nothing.
let isAutoQueued = false

const STOPPED_HINT = 'Automatic suggestions are stopped for this session; /rs start turns them back on.'

/**
 * Asks Haiku for 3 names. Without `force`, shows them only if the subject has
 * changed compared to the baseline name. `avoid` lists names already shown,
 * so Haiku proposes different ones. Returns the names shown, or the reason
 * for the failure.
 */
async function suggest($: Engine, force: boolean, avoid: readonly string[] = []): Promise<string[] | string> {
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return 'could not read the conversation'
  const convo = transcript(messages)
  if (convo === '') return 'the conversation is empty'

  const project = forcedProject || projectCode(await $.session.cwd())
  const current = await read($, baseline)
  const r = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt: prompt(convo, project, current, settings, avoid),
    effort: 'low',
    maxTokens: 400,
    timeoutMs: 20000,
  })
  // Every call counts, even a failed one or one that shows no suggestion.
  await update($, total, prev => addUsage(prev ?? NO_SPEND, r.usage))
  if (!r.isAnswered) return `Haiku did not answer (${r.reason})`

  const verdict = parseVerdict(r.text)
  if (verdict === undefined) return "could not read Haiku's answer"
  // Stop pressed while this automatic call was on its way: show nothing.
  if (!force && ((current !== null && verdict.isSameSubject) || (await read($, isStopped)))) return []

  const next = names(settings.template, project, verdict)
  await update($, suggestions, prev => (sameList(prev, next) ? prev : next))
  await update($, lastCall, () => addUsage(NO_SPEND, r.usage))
  return next
}

/** Runs `job` with the band's spinner turning. */
async function spinning<T>($: Engine, job: () => Promise<T>): Promise<T> {
  await update($, frame, () => 0)
  await update($, isGenerating, () => true)
  const tick = $.clock.every(100, () => {
    void update($, frame, f => f + 1)
  })
  try {
    return await job()
  } finally {
    tick.cancel()
    await update($, isGenerating, () => false)
  }
}

/** Asks for 3 names different from those shown (Reroll button, /rs). */
function reroll($: Engine): Promise<string[] | string> {
  return enqueue(() => spinning($, async () => suggest($, true, await read($, suggestions))))
}

/**
 * An automatic call is shown as generating only when its names will likely be
 * shown: the band is already up, or the session has no name yet. Otherwise
 * (same subject, the usual case) the band would flash after every reply.
 */
async function auto($: Engine): Promise<string[] | string> {
  // Stopped: no Haiku call at all.
  if (await read($, isStopped)) return []
  const isAwaited = (await read($, suggestions)).length > 0 || (await read($, baseline)) === null
  return isAwaited ? spinning($, () => suggest($, false)) : suggest($, false)
}

/** Turns automatic suggestions off (hiding the band) or back on for this session. */
async function setStopped($: Engine, stopped: boolean) {
  await update($, isStopped, () => stopped)
  if (stopped) await update($, suggestions, () => [])
}

/** Runs a suggestion outside the turn, without delaying it. */
function schedule($: Engine) {
  if (isAutoQueued) return
  isAutoQueued = true
  $.clock.after(0, () => {
    enqueue(() => {
      isAutoQueued = false
      return auto($)
    }).catch(() => {
      // A failed suggestion must never get in the way of the session.
    })
  })
}

export const register: Register = (on, options) => {
  const template = text(options.template)
  // A template without {desc} would give meaningless names: keep the default.
  const isUsable = specs(template).some(s => s.field === 'desc')
  rejectedTemplate = isUsable || template === '' ? undefined : template
  settings = { template: isUsable ? template : DEFAULT_TEMPLATE, rules: text(options.rules) }
  forcedProject = text(options.project)
  isCostShown = options.showCost !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'rs',
      description: 'Rename suggest: Haiku suggests 3 session names now (/rs stop|start: automatic suggestions off/on; /rs help)',
      argumentHint: '[help|stop|start]',
    })
    return next(e)
  })

  // Resumed session that already has a name: that name becomes the baseline.
  on('classic.SessionStart', async ($, e, next) => {
    const title = e.session_title?.trim()
    if (title) await update($, baseline, prev => prev ?? title)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') schedule($)
    return next(e)
  })

  on('command.run', { command: 'rs' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'stop') {
      await setStopped($, true)
      return { text: `Session names: ${STOPPED_HINT}` }
    }
    if (arg === 'start') {
      await setStopped($, false)
      return { text: 'Session names: automatic suggestions back on for this session.' }
    }
    if (arg === 'help') {
      const project = forcedProject || projectCode(await $.session.cwd())
      const [spent, stopped] = await Promise.all([read($, total), read($, isStopped)])
      return {
        text: helpText({
          ...settings,
          project,
          isProjectForced: forcedProject !== '',
          rejectedTemplate,
          total: spent,
          isCostShown,
          isStopped: stopped,
        }),
      }
    }
    // With the band shown, /rs asks for different names (like Reroll).
    const shown = await reroll($)
    if (typeof shown === 'string') return { text: `No suggestion: ${shown}.` }
    const [stopped, call, spent] = await Promise.all([read($, isStopped), read($, lastCall), read($, total)])
    return {
      text: [
        'Suggestions in the band above the prompt:',
        ...shown.map((n, i) => `${i + 1}. ${n}`),
        ...(isCostShown ? [`Cost: ${call ? spendText(call) : '?'} · this session: ${spendText(spent, true)}`] : []),
        ...(stopped ? [STOPPED_HINT] : []),
      ].join('\n'),
    }
  })

  // Any /rename (yours or the band's) becomes the new baseline.
  on('command.run', { command: 'rename' }, async ($, e, next) => {
    const result = await next(e)
    const title = e.args.trim()
    if (title) {
      await update($, baseline, () => title)
      await update($, suggestions, () => [])
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, suggestions)
    const generating = await read($, isGenerating)
    if (e.props.hasSurvey || (shown.length === 0 && !generating)) return next(e)
    const spin = generating ? `${SPINNER[(await read($, frame)) % SPINNER.length]} generating names…` : ''

    const { Box, Button, Text } = $.ui.resolve(e)
    if (shown.length === 0) {
      return (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>Session name:</Text>
          <Text color="claude">
            {spin}
          </Text>
        </Box>
      )
    }
    const call = await read($, lastCall)
    const spent = await read($, total)

    const choose = async (name: string) => {
      try {
        await $.command.run({ command: 'rename', args: name })
      } catch {
        $.ui.toast(`Could not rename, type: /rename ${name}`)
      }
      await update($, baseline, () => name)
      await update($, suggestions, () => [])
    }

    const dismiss = async () => {
      // The current subject becomes the baseline: suggestions only come back if it changes.
      await update($, baseline, () => shown[0])
      await update($, suggestions, () => [])
    }

    const onReroll = async () => {
      try {
        const result = await reroll($)
        if (typeof result === 'string') $.ui.toast(`No new names: ${result}.`)
      } catch {
        $.ui.toast('No new names: Haiku could not be reached.')
      }
    }

    const onStop = async () => {
      await setStopped($, true)
      $.ui.toast(STOPPED_HINT)
    }

    return (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Text dimColor>Session name:</Text>
        {shown.map((name, i) => (
          <Button
            key={`pick-${i}`}
            label={name}
            hotkey={String(i + 1)}
            variant={i === 0 ? 'primary' : 'secondary'}
            onPress={() => choose(name)}
          />
        ))}
        {generating ? (
          <Text color="claude">
            {spin}
          </Text>
        ) : (
          <Button key="reroll" label="Reroll" hotkey="r" onPress={onReroll} />
        )}
        <Button key="dismiss" label="Dismiss" hotkey="x" role="dismiss" onPress={dismiss} />
        <Button key="stop" label="Stop" hotkey="s" onPress={onStop} />
        {isCostShown && (
          <Text key="cost" dimColor>
            {call ? `${spendText(call)} · ` : ''}session {spendText(spent, true)}
          </Text>
        )}
      </Box>
    )
  })
}
