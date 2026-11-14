# Runs check.ts against the real extension in Chromium, paired the way a person's browser is (kage add browser),
# in a throwaway home folder. From the repo root: uv run --with playwright python extension/tests/e2e/run.py
# (once: uvx playwright install chromium). Exits with check.ts's code.
import asyncio, os, socket, subprocess, sys, tempfile
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[3]
EXT = ROOT / 'extension'

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

async def main():
    home = Path(tempfile.mkdtemp(prefix='kage-e2e-'))
    profile = home / '.config' / 'chromium'
    profile.mkdir(parents=True)
    (home / '.config' / 'kage').mkdir(parents=True)
    hub_port, page_port = free_port(), free_port()
    env_file = home / '.config' / 'kage' / 'env'
    env_file.write_text(f'KAGE_NAME=kage\nKAGE_BROWSER_PORT={hub_port}\n')
    env = {**os.environ, 'HOME': str(home)}
    env.setdefault('PLAYWRIGHT_BROWSERS_PATH', str(Path(os.environ['HOME']) / '.cache' / 'ms-playwright'))
    subprocess.run(['node', 'cli/registry.ts', 'add', 'browser'], cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
    token = next(l.split('=', 1)[1] for l in env_file.read_text().splitlines() if l.startswith('KAGE_BROWSER_TOKEN='))
    site = subprocess.Popen([sys.executable, '-m', 'http.server', str(page_port), '--bind', '127.0.0.1', '-d', str(Path(__file__).parent)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    check = subprocess.Popen(['node', str(Path(__file__).parent / 'check.ts')], cwd=ROOT, env={**env, 'KAGE_E2E_TOKEN': token, 'KAGE_E2E_PORT': str(hub_port)})
    try:
        async with async_playwright() as p:
            os.environ['HOME'] = str(home)   # Chromium looks for the pairing helper under this home
            ctx = await p.chromium.launch_persistent_context(str(profile), channel='chromium', headless=True,
                args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
            page = await ctx.new_page()
            await page.goto(f'http://127.0.0.1:{page_port}/page.html')
            await page.bring_to_front()
            while check.poll() is None:
                await asyncio.sleep(0.5)
            await ctx.close()
    finally:
        site.terminate()
        if check.poll() is None: check.terminate()
    return check.returncode

sys.exit(asyncio.run(main()))
