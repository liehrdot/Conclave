# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller build of the desktop backend: one folder (``--onedir`` – starts faster than a single file and
does not unpack to %TEMP%, which virus scanners dislike).

    uv run pyinstaller desktop/sidecar/backend.spec            → dist/conclave-backend/

Bundled besides the code: the GUI's static files. The sync server, its phone app and the test helpers are left out."""

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

datas = [
    (str(ROOT / "src/mtgdeck/gui/static"), "mtgdeck/gui/static"),
]
datas += collect_data_files("certifi")

hiddenimports = (
    collect_submodules("mtgdeck")
    + collect_submodules("uvicorn")
    + ["segno", "PIL.Image", "PIL.ImageFilter", "PIL.ImageEnhance", "PIL.ImageDraw", "PIL.ImageFont"]
    + (["winpty"] if sys.platform == "win32" else ["ptyprocess"])
)
excludes = ["mtgdeck.sync.server", "tkinter", "numpy", "pytest", "inquirerpy", "IPython", "matplotlib"]

a = Analysis(
    [str(ROOT / "desktop/sidecar/entry.py")],
    pathex=[str(ROOT / "src")],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="conclave-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,  # the shell reads MTGDECK_URL from stdout; it starts the exe without a visible window
    disable_windowed_traceback=False,
    icon=str(ROOT / "desktop/icon.ico") if (ROOT / "desktop/icon.ico").exists() else None,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="conclave-backend")
