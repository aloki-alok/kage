import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk'
import { SLACK_READS } from './slack-read-tools.ts'
import { log } from './log.ts'
import { senderOf, type Sender } from '../core/gate.ts'
import { DREAM_KEY } from '../core/dream.ts'
import { dreamNoteRefusal, toolRefusal } from './path-guards.ts'
import { grantRefusal, shellGrant } from '../core/kagelets/kagelet.ts'
import { heldCommand } from '../core/held.ts'
import { approvalPreview } from '../core/preview.ts'
import { eventNeedsCard } from '../core/tripwire.ts'
import type { Review } from './kagelets/review.ts'
import type { Task } from '../core/task.ts'
import type { Hub, Session, SdkOptions } from './sdk-sessions.ts'

const ALLOWED = ['reply', 'edit_message', 'delete_message', 'send_file', 'make_canvas', 'edit_canvas', 'message_people', 'schedule', 'unschedule', 'schedules', 'set_model', 'kagelets', 'review_kagelet_memory', 'browser_tabs', 'browser_read', 'browser_take_screenshot', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press_key', 'browser_navigate', 'computer_look', 'computer_act', 'computer_record', 'set_setting', 'meeting_join', 'flag_knowledge', 'dream_lessons'].map(t => `mcp__kage__${t}`)

export const senderNow = (o: Pick<SdkOptions, 'trustedNow'>, s: { sender?: Sender; turn: { task: Task }[] }): Sender | undefined =>
  s.sender !== 'trusted' ? s.sender : s.turn.some(x => x.task.trusted) && s.turn.every(x => !x.task.trusted || (o.trustedNow?.(x.task.trusted) ?? true)) ? 'trusted' : 'teammate'

export const denyAll = (s: Session) => { for (const done of [...s.asks.values()]) done('deny') }

export function canUse({ o }: Hub, key: string, s: Session): CanUseTool {
  return (name, input, x) => o.grantOf?.(key)
    ? Promise.resolve(grantRefusal(name, o.grantOf(key)!, input, o.allowOf?.(key)) ? { behavior: 'deny' as const, message: 'A kagelet approves nothing. Say in the thread what you needed and why: your manager decides.' }
      : { behavior: 'allow' as const, updatedInput: input })
    : (ALLOWED.includes(name) && !eventNeedsCard(name, input, senderNow(o, s))) || SLACK_READS.includes(name) || (name === 'mcp__kage__manage_kagelet' && (input.action === 'save' || input.action === 'revoke')) ? Promise.resolve({ behavior: 'allow' as const, updatedInput: input })
    : s.turn.some(x => senderOf(x.task) === 'agent') ? Promise.resolve({ behavior: 'deny' as const, message: "An agent's task may only read and answer: no card goes to the owner." }) : o.deferred?.take(key, name, input, Date.now()) ? Promise.resolve({ behavior: 'allow' as const, updatedInput: input })
    : o.deferred && s.turn.length ? defer({ o }, key, s, name, x.title ?? x.description ?? '', input)
    : ask({ o }, key, s, name, x.title ?? x.description ?? '', input, x.signal)
}

export function preToolUse({ o }: Hub, key: string, s: Session): HookCallback {
  return async input => {
    const i = input as { tool_name: string; tool_input?: Record<string, string> }
    const grant = o.grantOf?.(key)
    const path = toolRefusal(i.tool_name, i.tool_input ?? {}, s.turn.some(x => senderOf(x.task) === 'agent') ? 'agent' : senderNow(o, s), { ...o, side: key.includes('#side-') }) ?? (key === DREAM_KEY && o.ownMemory ? dreamNoteRefusal(i.tool_name, i.tool_input ?? {}, o.ownMemory) : undefined), held = grant && grantRefusal(i.tool_name, grant, i.tool_input ?? {}, o.allowOf?.(key))
    const step = !!held && !path && i.tool_name === 'Bash' && shellGrant(grant!), command = { command: String(i.tool_input?.command ?? '') }
    const taken = step && !!o.deferred?.take(key, 'Bash', command, Date.now()), deniedAt = step && !taken ? o.deferred?.deniedAt(key, 'Bash', command, Date.now()) : undefined, wait = step && !taken && !deniedAt ? o.deferred?.waiting(key, 'Bash', command, Date.now()) : undefined
    const review = step && !taken && !deniedAt && wait !== 'same' ? await o.reviewHeld?.(key, command.command) : undefined, released = taken || !!review?.release, card = step && !released && !deniedAt && !wait && o.deferred && s.turn.length ? await defer({ o }, key, s, 'Bash', `A kagelet's one-way step: ${heldCommand(command.command)}. Reply \`always\` to run it and let this exact command run with no ask from now on.`, command, review?.said) : undefined
    const reason = released ? undefined : deniedAt ? `Held back: the owner said no to this exact step on ${new Date(deniedAt).toLocaleDateString('en-CA')}. Do not run it or ask again. Tell the thread you stopped.` : card?.interrupt || wait === 'same' ? `Held: ${heldCommand(command.command)} is a one-way step. The owner's card is posted, so it is not in your needs. Go on with the rest of the job; when they answer, a new task says so.` : held || path
    if (grant) o.onTool?.(key, i.tool_name, reason || undefined)
    return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : released ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } } : {}
  }
}

export function ask({ o }: Pick<Hub, 'o'>, key: string, s: Session, tool: string, description: string, input: Record<string, unknown>, signal: AbortSignal) {
  const id = requestId()
  return new Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }>(resolve => {
    const done = (b: 'allow' | 'deny') => {
      s.asks.delete(id)
      resolve(b === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The owner did not approve this.' })
    }
    if (signal.aborted) return done('deny')
    s.asks.set(id, done)
    signal.addEventListener('abort', () => done('deny'), { once: true })
    s.kage.askOwner({ id, tool, description, preview: approvalPreview(tool, input) }).then(
      () => { if (s.asks.has(id)) o.hub().permission(key, id) },
      e => { log('permission prompt failed', e?.data?.error ?? e); done('deny') },
    )
  })
}

async function defer({ o }: Pick<Hub, 'o'>, key: string, s: Session, tool: string, description: string, input: Record<string, unknown>, review?: Review['said']) {
  const store = o.deferred!
  const id = requestId()
  try { await s.kage.askOwner({ id, tool, description, preview: approvalPreview(tool, input) }) } catch (e: any) {
    log('permission prompt failed', e?.data?.error ?? e)
    return { behavior: 'deny' as const, message: 'The owner did not approve this.' }
  }
  store.add({ id, key, tool, input, task: s.turn.at(-1)!.task, ...review && { review } }, Date.now())
  return { behavior: 'deny' as const, interrupt: true, message: "The owner's card is posted. This turn ends here. When they answer, a new task says so." }
}

function requestId() {
  const abc = 'abcdefghijkmnopqrstuvwxyz'
  return Array.from({ length: 5 }, () => abc[Math.floor(Math.random() * abc.length)]).join('')
}
