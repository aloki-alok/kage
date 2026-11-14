// hub.ts calls this before it loads the router, so no session copies a held key (#182). Node modules only: it must load even when key-proxy.ts cannot.
// If key-proxy.ts fails to load, the names are still removed from the environment: a session without a key beats a session holding it.
export async function holdKeys(names: string[], say: (s: string) => void, load: () => Promise<{ hold: (n: string[]) => void }> = () => import('./key-proxy.ts')) {
  try { (await load()).hold(names) } catch (e) { for (const n of names) delete process.env[n]; say(`could not set up the key proxy, so its keys were dropped: ${e}`) }
}
