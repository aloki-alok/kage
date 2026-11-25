import type { PanelAction } from '../core/kagelets/view.ts'
import type { Task } from '../core/task.ts'
import type { ProbeArg } from './probe-jobs.ts'

export type Verdict = { type: 'verdict'; request_id: string; behavior: 'allow' | 'deny' }
export type ToSession = Task | Verdict
export type ChannelReply = { type: 'mail' | 'wa' | 'voice' | 'sms'; text: string }

export type FromSession =
  | { type: 'board' }
  | { type: 'health' }
  | { type: 'end'; key: string; cut?: boolean }
  | { type: 'quiesce' }
  | { type: 'update'; stable?: boolean }
  | { type: 'reload' }
  | { type: 'callcode' }
  | { type: 'stop'; key: string }
  | { type: 'kagelet'; action: PanelAction; name: string }
  | { type: 'tell'; key: string; text: string }
  | { type: 'say'; text: string; channel?: string; thread_ts?: string }
  | { type: 'away'; back?: true; until?: string; minutes?: number; note?: string }
  | { type: 'relay'; action: 'allow' | 'deny' | 'list'; key?: string }
  | { type: 'hold'; key: string; pid: number }
  | { type: 'hello'; key: string; linkToken: string }
  | { type: 'permission'; id: string }
  | ChannelReply
  | { type: 'schedule'; id: string; cron: string; prompt: string; recurring: boolean; lane?: boolean; model?: string; probe?: ProbeArg; shadow?: { of: string; live: string } }
  | { type: 'unschedule'; id: string }

