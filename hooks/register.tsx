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

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])

// Mod options (/config); a change reloads the module, so register reads them again.
let settings: Settings = { template: DEFAULT_TEMPLATE, rules: '' }
let forcedProject = ''
let isCostShown = true
let rejectedTemplate: string | undefined

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

// One request to Haiku at a time; a request that arrives meanwhile triggers one rerun.
let isRunning = false
let isPending = false

/**
 * Asks Haiku for 3 names. Without `force`, shows them only if the subject has
 * changed compared to the baseline name. Returns the names shown, or the
 * reason for the failure.
 */
async function suggest($: Engine, force: boolean): Promise<string[] | string> {
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return 'could not read the conversation'
  const convo = transcript(messages)
  if (convo === '') return 'the conversation is empty'

  const project = forcedProject || projectCode(await $.session.cwd())
  const current = await read($, baseline)
  const r = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt: prompt(convo, project, current, settings),
    effort: 'low',
    maxTokens: 400,
    timeoutMs: 20000,
  })
  // Every call counts, even a failed one or one that shows no suggestion.
  await update($, total, prev => addUsage(prev ?? NO_SPEND, r.usage))
  if (!r.isAnswered) return `Haiku did not answer (${r.reason})`

  const verdict = parseVerdict(r.text)
  if (verdict === undefined) return "could not read Haiku's answer"
  if (!force && current !== null && verdict.isSameSubject) return []

  const next = names(settings.template, project, verdict)
  await update($, suggestions, prev => (sameList(prev, next) ? prev : next))
  await update($, lastCall, () => addUsage(NO_SPEND, r.usage))
  return next
}

async function drain($: Engine) {
  while (isPending) {
    isPending = false
    try {
      await suggest($, false)
    } catch {
      // A failed suggestion must never get in the way of the session.
    }
  }
  isRunning = false
}

/** Runs a suggestion outside the turn, without delaying it. */
function schedule($: Engine) {
  isPending = true
  if (isRunning) return
  isRunning = true
  $.clock.after(0, () => {
    void drain($)
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
      description: 'Rename suggest: Haiku suggests 3 session names now (/rs help: how it works and settings)',
      argumentHint: '[help]',
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
    if (e.args.trim() === 'help') {
      const project = forcedProject || projectCode(await $.session.cwd())
      return {
        text: helpText({
          ...settings,
          project,
          isProjectForced: forcedProject !== '',
          rejectedTemplate,
          total: await read($, total),
          isCostShown,
        }),
      }
    }
    const shown = await suggest($, true)
    if (typeof shown === 'string') return { text: `No suggestion: ${shown}.` }
    const call = await read($, lastCall)
    const spent = await read($, total)
    return {
      text: [
        'Suggestions in the band above the prompt:',
        ...shown.map((n, i) => `${i + 1}. ${n}`),
        ...(isCostShown ? [`Cost: ${call ? spendText(call) : '?'} · this session: ${spendText(spent, true)}`] : []),
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
    if (e.props.hasSurvey || shown.length === 0) return next(e)
    const call = await read($, lastCall)
    const spent = await read($, total)

    const { Box, Button, Text } = $.ui.resolve(e)

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
        <Button key="dismiss" label="Dismiss" hotkey="x" role="dismiss" onPress={dismiss} />
        {isCostShown && (
          <Text key="cost" dimColor>
            {call ? `${spendText(call)} · ` : ''}session {spendText(spent, true)}
          </Text>
        )}
      </Box>
    )
  })
}
