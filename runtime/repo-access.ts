// Whether this install may push to the Kage repo, which is how the hub knows it is the repo owner's.
// run: a `gh` call, passed in so the test needs no network.
export async function canPushToKage(run: (args: string[]) => Promise<string>): Promise<boolean> {
  try { return (await run(['api', 'repos/aloki-alok/kage', '--jq', '.permissions.push'])).trim() === 'true' } catch { return false }
}
