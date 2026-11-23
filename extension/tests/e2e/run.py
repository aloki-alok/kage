import json
import asyncio, os, shutil, socket, subprocess, sys, tempfile
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[3]

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

async def main():
    home = Path(tempfile.mkdtemp(prefix='kage-e2e-'))
    profile = home / ('Library/Application Support/Chromium' if sys.platform == 'darwin' else '.config/chromium')
    profile.mkdir(parents=True)
    (home / '.config' / 'kage').mkdir(parents=True)
    hub_port, page_port = free_port(), free_port()
    # A copy, so the check can change its version on disk the way a git pull would.
    EXT = home / 'extension'
    shutil.copytree(ROOT / 'extension', EXT, ignore=shutil.ignore_patterns('tests'))
    env_file = home / '.config' / 'kage' / 'env'
    env_file.write_text(f'KAGE_NAME=kage\nKAGE_BROWSER_PORT={hub_port}\n')
    env = {**os.environ, 'HOME': str(home)}
    env.setdefault('PLAYWRIGHT_BROWSERS_PATH', str(Path(os.environ['HOME']) / '.cache' / 'ms-playwright'))
    # Stand-ins for open and pbcopy, so pairing never opens the tester's own Chrome and Finder or takes their clipboard.
    stubs = home / 'bin'
    stubs.mkdir()
    for c in ['open', 'pbcopy', 'xdg-open', 'google-chrome', 'chromium', 'wl-copy', 'xclip', 'xsel']:
        (stubs / c).write_text('#!/bin/sh\nexit 0\n')
        (stubs / c).chmod(0o755)
    env['PATH'] = f"{stubs}:{env['PATH']}"
    subprocess.run(['node', 'src/cli/connect.ts', 'browser'], cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
    token = json.loads((home / '.config' / 'kage' / 'secrets.json').read_text())['browserToken']
    site = subprocess.Popen([sys.executable, '-m', 'http.server', str(page_port), '--bind', '127.0.0.1', '-d', str(Path(__file__).parent)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    check = subprocess.Popen(['node', str(Path(__file__).parent / 'check.ts')], cwd=ROOT, env={**env, 'KAGE_E2E_TOKEN': token, 'KAGE_E2E_PORT': str(hub_port), 'KAGE_E2E_EXT': str(EXT)})
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
        shutil.rmtree(home, ignore_errors=True)
    return check.returncode

sys.exit(asyncio.run(main()))
