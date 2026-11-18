export async function holdKeys(names: string[], say: (s: string) => void, load: () => Promise<{ hold: (n: string[]) => void }> = () => import('./key-proxy.ts')) {
  try { (await load()).hold(names) } catch (e) { for (const n of names) delete process.env[n]; say(`could not set up the key proxy, so its keys were dropped: ${e}`) }
}
