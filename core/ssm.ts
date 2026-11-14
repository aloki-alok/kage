// The SSM relay's rules (runtime/ssm-relay.ts): the one header line a client sends, and which threads may hold a token.
// A target is an EC2 instance (i-) or a managed instance (mi-). Only digits, hex and dashes ever reach the aws command line.
const TARGET = /^(i|mi)-[0-9a-f]{8,17}$/
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/

export type Relay = { token: string; target: string; port: number; region: string | undefined }

export function relayHeader(line: string): Relay | { error: string } {
  const [token, target, p, region, ...rest] = line.trim().split(/ +/)
  if (!token || !target || !p || rest.length) return { error: 'expected: <token> <target> <port> [region]' }
  if (!TARGET.test(target)) return { error: 'target must be an instance id (i-... or mi-...)' }
  if (!/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535) return { error: 'port must be 1 to 65535' }
  if (region !== undefined && !REGION.test(region)) return { error: 'region is not an AWS region name' }
  return { token, target, port: Number(p), region }
}

// A Slack thread of the owner, or its lane. Email, WhatsApp, voice and another agent's keys never qualify, whoever sent the task.
export const ssmEligible = (key: string) => /^(dm|[CDG][A-Z0-9]+:\d+\.\d+)(#side-.+)?$/.test(key)
