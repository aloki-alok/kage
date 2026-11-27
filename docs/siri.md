# Ask Kage from Siri

Say "Hey Siri, ask Kage", then say what you want. Siri reads back a short answer. Longer work goes on in its own thread in your DM with Kage, and the result lands there. Every setting and answer is in [docs/settings.md, "Ask Kage from Siri"](settings.md#ask-kage-from-siri).

You need Tailscale on the Mac that runs Kage and on your iPhone, both signed in to the same tailnet. The Siri route is open on your tailnet only.

## Turn it on

1. On the Mac, run `kage connector on siri`. It prints the token once. Keep the window open.
2. Run `kage tunnel on`. Check: its output has `ok siri is on your tailnet at <machine>.<tailnet>.ts.net:8794`.
3. Run `kage doctor`. Check: the last line is `All good`.

## Make the Shortcut

On the iPhone, open Shortcuts and tap **+**. Name the Shortcut `Ask Kage`, because Siri runs a Shortcut by its name. Add these actions in this order:

1. **Dictate Text.** Set **Stop Listening** to **After Pause**.
2. **Get Contents of URL.**
   - URL: `http://<machine>.<tailnet>.ts.net:8794/ask`, with the host from step 2 above.
   - Method: **POST**.
   - Headers: add `Authorization` with the value `Bearer <token>`, using the token from step 1 above.
   - Request Body: **JSON**. Add a field `text` of type **Text**, and set it to the **Dictated Text** variable.
3. **Get Dictionary Value.** Get **Value** for key `say` in **Contents of URL**.
4. **Speak Text.** Speak **Dictionary Value**.

## Try it

1. Say "Hey Siri, ask Kage". Siri asks for your words.
2. Say "what is on my calendar today". Check: Siri reads the answer, and your DM with Kage has a new 🎙️ thread with the same answer.
3. Say "Hey Siri, ask Kage", then "investigate yesterday's failed calls". Check: Siri says "I saved ... I'll reply in Slack." Later the result shows in that thread.

If Siri says nothing, or says it could not connect, check that the Tailscale VPN is on in the iPhone's Tailscale app. Then run `kage logs 50` on the Mac and look for a `siri ask` line.

Words said after "Hey Siri, ask Kage" in the same breath may not reach the Shortcut. Siri asks for them instead, through **Dictate Text**.
