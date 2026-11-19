export type Task = {
  type: 'task'
  content: string
  fromOwner: boolean
  meta: { channel: string; thread_ts: string; place: string; permalink: string }
  origin: { channel: string; ts: string; thread?: string }
  source?: string
  job?: string
  agent?: { app: string; tag?: string; person?: string }
  trusted?: string
  scheduled?: true
  handoff?: { chain: string; message: string; hops: number }
  need?: { name: string; id: string }
}
