export async function canPushToKage(run: (args: string[]) => Promise<string>): Promise<boolean> {
  try { return (await run(['api', 'repos/aloki-alok/kage', '--jq', '.permissions.push'])).trim() === 'true' } catch { return false }
}
