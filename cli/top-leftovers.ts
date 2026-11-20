import { leftovers } from './doctor/leftovers.ts'

let count = 0
const look = async () => { try { count = (await leftovers()).length } catch { count = 0 } }
void look()
setInterval(() => { void look() }, 60_000).unref()

export const leftoverCount = () => count
