# Application icons

The launcher icons of MOVE OpenLab (Linux application menu, Windows Start menu, macOS Applications folder): the
**official MOVE OpenLab symbol** — the blue-to-green infinity-shaped road with its leaf — unchanged in colour, shape and
proportion, centred on a transparent square.

| File | Use |
|---|---|
| `move-openlab-16.png` … `move-openlab-512.png`, `move-openlab-1024.png` | Linux icon theme (`~/.local/share/icons/hicolor/<size>/apps/move-openlab.png`) |
| `move-openlab.ico` (16–256 px) | Windows shortcut |
| `move-openlab.icns` | macOS application bundle |

Source: the approved MOVE OpenLab logo pack, `02_icon/move-openlab-icon-1024-transparent.png`
(SHA-256 `dab5f5b90f31f207e96382e2e96595922ea1f0aa4d428d2582d56b402e25e482`). That square icon was cut from the full
logo and carries small separate fragments of the tagline next to the leaf; `scripts/release/build_icons.py` keeps the
symbol's own pixels (its regions of at least 2,000 opaque pixels), erases those fragments, crops and centres it, and
writes every size. Nothing is redrawn or recoloured.

The MOVE OpenLab name and logo are the project's marks: the Apache License grants no right to use them (NOTICE).
