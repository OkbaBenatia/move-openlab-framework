"""MOVE OpenLab as a background application of the signed-in user, on Linux, macOS and Windows.

The same application (``move-openlab serve``) runs in all three cases; only the mechanism that keeps it running
differs, and every mechanism is the operating system's own per-user one (no administrator rights, nothing starts
before the user signs in, nothing listens beyond this computer):

=========  ===============================================  ==========================================
Platform   Background mechanism                             Restarts after a crash
=========  ===============================================  ==========================================
Linux      ``systemd --user`` unit ``move-openlab.service``  ``Restart=on-failure``
macOS      ``launchd`` user agent (``~/Library/LaunchAgents``)  ``KeepAlive`` / ``SuccessfulExit=false``
Windows    Task Scheduler task ``\\MOVE OpenLab\\Server``     task restart policy (every minute)
=========  ===============================================  ==========================================

Where the per-user mechanism is unavailable (for example a Linux session without a ``systemd --user`` manager) the
server is started as a detached process and started again at the next sign-in by the desktop's autostart entry; it
is then not restarted automatically after a crash, and ``service status`` says so.

An installation is a folder chosen by the user (the installer puts ``app/``, ``venv/`` and ``move-openlab.json`` in it)
plus a data directory in the operating system's place for application data (accounts, experiments, results), kept
when the folder or the service is removed.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from . import __version__, privatefiles

CONFIG_NAME = "move-openlab.json"
SERVICE = "move-openlab"
MAC_LABEL = "io.github.okbabenatia.move-openlab"
WIN_TASK_PATH, WIN_TASK = "\\MOVE OpenLab\\", "Server"
DEFAULT_PORT, PORT_RANGE = 8765, range(8765, 8800)
EXIT_PORT_IN_USE = 3


# ----------------------------------------------------------------------------------------------------------- places
def platform_name() -> str:
    return "windows" if sys.platform.startswith("win") else "macos" if sys.platform == "darwin" else "linux"


def default_data_dir() -> Path:
    home = Path.home()
    if platform_name() == "windows":
        return Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local") / "MOVE OpenLab" / "data"
    if platform_name() == "macos":
        return home / "Library" / "Application Support" / "MOVE OpenLab"
    return Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share") / "move-openlab"


def log_dir(cfg: dict) -> Path:
    return Path(cfg["data_dir"]) / "logs"


def venv_python(home: Path, windowed: bool = False) -> Path:
    if platform_name() == "windows":
        return home / "venv" / "Scripts" / ("pythonw.exe" if windowed else "python.exe")
    return home / "venv" / "bin" / "python"


def find_config(explicit: str | None = None) -> Path | None:
    """The configuration of this installation: ``--config``, ``MOVE_OPENLAB_CONFIG``, or the file next to the
    virtual environment this command runs from (``<folder>/venv`` → ``<folder>/move-openlab.json``)."""
    for c in (explicit, os.environ.get("MOVE_OPENLAB_CONFIG"), Path(sys.prefix).parent / CONFIG_NAME):
        if c and Path(c).is_file():
            return Path(c)
    return None


def load_config(explicit: str | None = None) -> dict:
    p = find_config(explicit)
    if p is None:
        raise SystemExit("error: no MOVE OpenLab installation found (no move-openlab.json next to this program); "
                         "install it with the installer, or pass --config")
    cfg = json.loads(p.read_text())
    cfg["_path"] = str(p)
    return cfg


def base_url(cfg: dict) -> str:
    return f"http://127.0.0.1:{int(cfg['port'])}"


# ----------------------------------------------------------------------------------------------------------- probes
def port_free(port: int, host: str = "127.0.0.1") -> bool:
    """Can a server listen on this port now? Probed as the server binds (SO_REUSEADDR on POSIX, so connections of a
    just-stopped server still in TIME_WAIT do not count as "in use"; Windows has no such state for a listener)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if os.name == "posix":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def health(port: int, timeout: float = 2.0) -> dict | None:
    """The answer of a MOVE OpenLab server on this port, or None (nothing there, or another application)."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=timeout) as r:  # noqa: S310 (loopback only)
            d = json.loads(r.read().decode())
            return d if d.get("app") == "MOVE OpenLab" else None
    except (OSError, ValueError):
        return None


def choose_port(preferred: int | None = None) -> int:
    """The preferred port when it is free, else the first free one in 8765–8799."""
    for p in ([preferred] if preferred else []) + list(PORT_RANGE):
        if p and port_free(p):
            return p
    raise SystemExit("error: no free port between 8765 and 8799 on 127.0.0.1; pass --port with a free port")


def wait_until_up(port: int, seconds: float = 45) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if health(port):
            return True
        time.sleep(0.5)
    return False


# ----------------------------------------------------------------------------------------------------------- serve
def prepare_environment(cfg: dict) -> None:
    """Environment of the server process from the installation's configuration (an explicit variable wins), and a
    persistent session key so that sign-ins survive a restart (owner-only file in the data directory)."""
    data = Path(cfg["data_dir"])
    data.mkdir(parents=True, exist_ok=True)
    env = dict(MOVE_OPENLAB_DATA_DIR=str(data), MOVE_OPENLAB_FRONTEND_DIST=cfg.get("frontend_dist", ""),
               MOVE_OPENLAB_PLUGIN_DIR=cfg.get("plugin_dir", ""), MOVE_OPENLAB_PLUGIN_MODE=cfg.get("plugin_mode", "sandbox"))
    for k, v in env.items():
        if v and not os.environ.get(k):
            os.environ[k] = v
    if not os.environ.get("SESSION_SECRET"):
        f = data / "session-secret"
        try:
            secret = f.read_text().strip()
        except OSError:
            secret = ""
        if len(secret) < 32:
            import secrets
            secret = secrets.token_urlsafe(48)
            privatefiles.write(f, secret)
        os.environ["SESSION_SECRET"] = secret


def log_to_file(path: Path) -> None:
    """Server output to a size-limited log file (needed where there is no console: Windows task, launchd agent)."""
    import logging
    import logging.handlers
    path.parent.mkdir(parents=True, exist_ok=True)
    h = logging.handlers.RotatingFileHandler(path, maxBytes=5 * 2 ** 20, backupCount=3, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    for name in ("", "uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers[:] = [h]
        lg.propagate = False
        lg.setLevel(logging.INFO)
    stream = open(path.with_suffix(".out"), "a", encoding="utf-8", buffering=1)      # print() and crash traces
    sys.stdout = sys.stderr = stream


# ----------------------------------------------------------------------------------------------------------- backends
def _run(argv: list[str], check: bool = False, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, check=check, **kw)


def _ps(script: str) -> subprocess.CompletedProcess:
    return _run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])


def _q(s: str) -> str:
    """A PowerShell single-quoted string literal."""
    return "'" + str(s).replace("'", "''") + "'"


def serve_argv(cfg: dict, windowed: bool = False) -> list[str]:
    home = Path(cfg["home"])
    return [str(venv_python(home, windowed)), "-m", "move_openlab.cli", "serve", "--config", str(Path(cfg["_path"]))]


def systemd_user_available() -> bool:
    if platform_name() != "linux" or not shutil.which("systemctl"):
        return False
    return _run(["systemctl", "--user", "show-environment"]).returncode == 0


def _unit_path() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "systemd" / "user" / f"{SERVICE}.service"


def _unit(cfg: dict) -> str:
    exe = " ".join(f'"{a}"' for a in serve_argv(cfg))
    return f"""[Unit]
Description=MOVE OpenLab (local research server, 127.0.0.1:{cfg['port']})
Documentation=https://github.com/OkbaBenatia/move-openlab-framework

[Service]
Type=simple
ExecStart={exe}
Environment=PYTHONDONTWRITEBYTECODE=1
Restart=on-failure
RestartSec=5
RestartPreventExitStatus={EXIT_PORT_IN_USE}
NoNewPrivileges=yes
UMask=0077

[Install]
WantedBy=default.target
"""


def _plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{MAC_LABEL}.plist"


def _plist(cfg: dict) -> bytes:
    import plistlib
    logs = log_dir(cfg)
    return plistlib.dumps(dict(Label=MAC_LABEL, ProgramArguments=serve_argv(cfg), WorkingDirectory=cfg["home"],
                               RunAtLoad=True, KeepAlive=dict(SuccessfulExit=False), ThrottleInterval=10,
                               ProcessType="Background", Umask=0o077,
                               EnvironmentVariables=dict(PYTHONDONTWRITEBYTECODE="1"),
                               StandardOutPath=str(logs / "launchd.log"), StandardErrorPath=str(logs / "launchd.log")))


def _mac_domain() -> str:
    uid = os.getuid()
    return f"gui/{uid}" if _run(["launchctl", "print", f"gui/{uid}"]).returncode == 0 else f"user/{uid}"


def _autostart_desktop() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "autostart" / f"{SERVICE}.desktop"


def _pid_file(cfg: dict) -> Path:
    return Path(cfg["data_dir"]) / "server.pid"


def mechanism(cfg: dict) -> str:
    return cfg.get("mechanism") or {"linux": "systemd-user" if systemd_user_available() else "detached",
                                    "macos": "launchd", "windows": "task-scheduler"}[platform_name()]


def register(cfg: dict) -> str:
    """Register the background service (start at sign-in, restart after a crash); returns the mechanism used."""
    mech = mechanism(cfg)
    log_dir(cfg).mkdir(parents=True, exist_ok=True)
    if mech == "systemd-user":
        u = _unit_path()
        u.parent.mkdir(parents=True, exist_ok=True)
        u.write_text(_unit(cfg))
        _run(["systemctl", "--user", "daemon-reload"], check=True)
        _run(["systemctl", "--user", "enable", f"{SERVICE}.service"], check=True)
    elif mech == "launchd":
        p = _plist_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(_plist(cfg))
    elif mech == "task-scheduler":
        exe, *args = serve_argv(cfg, windowed=True)
        argline = " ".join(f'"{a}"' if " " in a else a for a in args)
        r = _ps(f"""$ErrorActionPreference = 'Stop'
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$a = New-ScheduledTaskAction -Execute {_q(exe)} -Argument {_q(argline)} -WorkingDirectory {_q(cfg['home'])}
$t = New-ScheduledTaskTrigger -AtLogOn -User $me
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
     -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$p = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskPath {_q(WIN_TASK_PATH)} -TaskName {_q(WIN_TASK)} -Action $a -Trigger $t -Settings $s -Principal $p `
     -Description 'MOVE OpenLab local research server (127.0.0.1 only)' -Force | Out-Null""")
        if r.returncode != 0:
            raise SystemExit(f"error: could not register the Task Scheduler task: {r.stderr.strip()[-400:]}")
    else:                                                       # detached + desktop autostart entry
        d = _autostart_desktop()
        d.parent.mkdir(parents=True, exist_ok=True)
        d.write_text(_desktop_entry(cfg, "start", "Start MOVE OpenLab in the background", autostart=True))
    return mech


def unregister(cfg: dict) -> None:
    mech = mechanism(cfg)
    stop(cfg)
    if mech == "systemd-user":
        _run(["systemctl", "--user", "disable", f"{SERVICE}.service"])
        _unit_path().unlink(missing_ok=True)
        _run(["systemctl", "--user", "daemon-reload"])
    elif mech == "launchd":
        _plist_path().unlink(missing_ok=True)
    elif mech == "task-scheduler":
        _ps(f"Unregister-ScheduledTask -TaskPath {_q(WIN_TASK_PATH)} -TaskName {_q(WIN_TASK)} -Confirm:$false")
    else:
        _autostart_desktop().unlink(missing_ok=True)


def start(cfg: dict) -> None:
    mech, port = mechanism(cfg), int(cfg["port"])
    if health(port):
        return
    if not port_free(port):
        raise SystemExit(f"error: port {port} on 127.0.0.1 is used by another application; free it, or reinstall "
                         f"with --port <another port>")
    if mech == "systemd-user":
        _run(["systemctl", "--user", "start", f"{SERVICE}.service"], check=True)
    elif mech == "launchd":
        dom = _mac_domain()
        if _run(["launchctl", "print", f"{dom}/{MAC_LABEL}"]).returncode != 0:
            for _ in range(20):                        # an agent still being unloaded refuses a new bootstrap for a moment
                r = _run(["launchctl", "bootstrap", dom, str(_plist_path())])
                if r.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise SystemExit(f"error: launchctl bootstrap failed: {r.stderr.strip()[-300:]}")
        else:
            _run(["launchctl", "kickstart", f"{dom}/{MAC_LABEL}"])
    elif mech == "task-scheduler":
        r = _ps(f"Start-ScheduledTask -TaskPath {_q(WIN_TASK_PATH)} -TaskName {_q(WIN_TASK)}")
        if r.returncode != 0:
            raise SystemExit(f"error: could not start the task: {r.stderr.strip()[-300:]}")
    else:
        logs = log_dir(cfg)
        logs.mkdir(parents=True, exist_ok=True)
        kw = dict(start_new_session=True) if os.name == "posix" else dict(creationflags=0x00000008 | 0x00000200)
        with open(logs / "detached.log", "ab") as out:
            p = subprocess.Popen(serve_argv(cfg), stdin=subprocess.DEVNULL, stdout=out, stderr=out, cwd=cfg["home"], **kw)
        privatefiles.write(_pid_file(cfg), str(p.pid))


def restart(cfg: dict) -> None:
    """Stop and start again. launchd restarts a loaded agent in place (``kickstart -k``): unloading and loading it
    again can take launchd tens of seconds."""
    if mechanism(cfg) == "launchd" and _run(["launchctl", "print", f"{_mac_domain()}/{MAC_LABEL}"]).returncode == 0:
        _run(["launchctl", "kickstart", "-k", f"{_mac_domain()}/{MAC_LABEL}"])
        return
    stop(cfg)
    start(cfg)


def stop(cfg: dict) -> None:
    mech = mechanism(cfg)
    if mech == "systemd-user":
        _run(["systemctl", "--user", "stop", f"{SERVICE}.service"])
    elif mech == "launchd":
        _run(["launchctl", "bootout", f"{_mac_domain()}/{MAC_LABEL}"])
    elif mech == "task-scheduler":
        _ps(f"Stop-ScheduledTask -TaskPath {_q(WIN_TASK_PATH)} -TaskName {_q(WIN_TASK)}")
    else:
        try:
            pid = int(_pid_file(cfg).read_text())
        except (OSError, ValueError):
            pid = 0
        if pid:
            try:
                import signal
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
            _pid_file(cfg).unlink(missing_ok=True)
    end = time.time() + 30                                     # stopped = no longer answering AND the port released
    while time.time() < end and (health(int(cfg["port"]), timeout=0.5) or not port_free(int(cfg["port"]))):
        time.sleep(0.3)


def status(cfg: dict) -> dict:
    mech = mechanism(cfg)
    registered = {"systemd-user": lambda: _unit_path().is_file(), "launchd": lambda: _plist_path().is_file(),
                  "task-scheduler": lambda: _ps(f"Get-ScheduledTask -TaskPath {_q(WIN_TASK_PATH)} -TaskName {_q(WIN_TASK)}").returncode == 0,
                  "detached": lambda: _autostart_desktop().is_file()}[mech]()
    h = health(int(cfg["port"]))
    return dict(installation=cfg["home"], version=cfg.get("version"), url=base_url(cfg), data_dir=cfg["data_dir"],
                mechanism=mech, registered=registered, running=bool(h),
                restarts_after_crash=mech != "detached", starts_at_sign_in=registered)


# ----------------------------------------------------------------------------------------------------------- launcher
def _desktop_entry(cfg: dict, action: str, comment: str, autostart: bool = False) -> str:
    exe = str(venv_python(Path(cfg["home"])))
    icon = Path(cfg["home"]) / "app" / "frontend" / "public" / "favicon.svg"
    lines = ["[Desktop Entry]", "Type=Application", "Name=MOVE OpenLab" if not autostart else "MOVE OpenLab (background)",
             f"Comment={comment}", f'Exec="{exe}" -m move_openlab.cli {"service start" if action == "start" else "open"}',
             "Terminal=false", "Categories=Science;Education;"]
    if icon.is_file():
        lines.append(f"Icon={icon}")
    if autostart:
        lines.append("X-GNOME-Autostart-enabled=true")
    return "\n".join(lines) + "\n"


def launcher_paths() -> list[Path]:
    if platform_name() == "windows":
        sm = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "Microsoft" / "Windows" / "Start Menu" / "Programs"
        return [sm / "MOVE OpenLab.lnk"]
    if platform_name() == "macos":
        return [Path.home() / "Applications" / "MOVE OpenLab.app"]
    return [Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "applications" / f"{SERVICE}.desktop"]


def create_launcher(cfg: dict) -> list[str]:
    """The "Open MOVE OpenLab" launcher (Start Menu, Applications folder, application menu): it starts the service
    if needed and opens the browser. Created with the user's rights only."""
    made = []
    home = Path(cfg["home"])
    if platform_name() == "windows":
        lnk = launcher_paths()[0]
        r = _ps(f"""$s = (New-Object -ComObject WScript.Shell).CreateShortcut({_q(lnk)})
$s.TargetPath = {_q(venv_python(home, windowed=True))}
$s.Arguments = '-m move_openlab.cli open'
$s.WorkingDirectory = {_q(home)}
$s.Description = 'Open MOVE OpenLab'
$s.Save()""")
        if r.returncode == 0:
            made.append(str(lnk))
    elif platform_name() == "macos":
        app = launcher_paths()[0]
        (app / "Contents" / "MacOS").mkdir(parents=True, exist_ok=True)
        import plistlib
        (app / "Contents" / "Info.plist").write_bytes(plistlib.dumps(dict(
            CFBundleName="MOVE OpenLab", CFBundleDisplayName="MOVE OpenLab", CFBundleIdentifier=MAC_LABEL + ".launcher",
            CFBundleExecutable="move-openlab", CFBundlePackageType="APPL", CFBundleShortVersionString=__version__,
            LSUIElement=True)))
        exe = app / "Contents" / "MacOS" / "move-openlab"
        exe.write_text(f'#!/bin/sh\nexec "{venv_python(home)}" -m move_openlab.cli open\n')
        exe.chmod(0o755)
        made.append(str(app))
    else:
        d = launcher_paths()[0]
        d.parent.mkdir(parents=True, exist_ok=True)
        d.write_text(_desktop_entry(cfg, "open", "Open the local MOVE OpenLab application in the browser"))
        made.append(str(d))
    return made


def remove_launcher() -> None:
    for p in launcher_paths():
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)


def open_url(cfg: dict) -> str:
    """The address to open: the first-run setup link (with its key in the #fragment) while no account exists,
    otherwise the application itself."""
    from .auth import setup as first_run
    url = base_url(cfg)
    try:
        with urllib.request.urlopen(url + "/api/setup/status", timeout=3) as r:      # noqa: S310 (loopback only)
            pending = json.loads(r.read().decode()).get("setup_required")
    except (OSError, ValueError):
        pending = False
    key = first_run.read_key(Path(cfg["data_dir"])) if pending else None
    return f"{url}/setup#{key}" if key else url + "/"


# ----------------------------------------------------------------------------------------------------------- install
def install(home: Path, port: int | None = None, data_dir: Path | None = None, launcher: bool = True,
            autostart: bool = True, browser: bool = True) -> dict:
    """Write the installation's configuration, register and start the background service, create the launcher and
    open the browser. Run by the installer from ``<folder>/venv``; safe to run again (update, repair)."""
    home = home.resolve()
    cfg_path = home / CONFIG_NAME
    old = json.loads(cfg_path.read_text()) if cfg_path.is_file() else {}
    data = Path(data_dir or old.get("data_dir") or default_data_dir()).expanduser().resolve()
    marker = data / "installation-home.txt"
    if marker.is_file():
        other = Path(marker.read_text().strip())
        if other != home and (other / CONFIG_NAME).is_file():
            raise SystemExit(f"error: MOVE OpenLab is already installed in {other} with this data directory; update it "
                             f"there (run its installer again in that folder), or install separately with --data-dir")
    if old:
        stop(dict(old, _path=str(cfg_path)))
    port = int(port or old.get("port") or 0) or choose_port(DEFAULT_PORT)
    if not port_free(port) and not health(port):
        raise SystemExit(f"error: port {port} on 127.0.0.1 is used by another application; choose one with --port")
    cfg = dict(version=__version__, home=str(home), port=port, host="127.0.0.1", data_dir=str(data),
               frontend_dist=str(home / "app" / "frontend" / "dist"), plugin_dir=str(home / "app" / "plugins"),
               plugin_mode="sandbox", platform=platform_name())
    data.mkdir(parents=True, exist_ok=True)
    privatefiles.write(marker, str(home))
    cfg_path.write_text(json.dumps(cfg, indent=1))
    cfg["_path"] = str(cfg_path)
    cfg["mechanism"] = mechanism(cfg) if autostart else "detached"
    if autostart:
        register(cfg)
    cfg_path.write_text(json.dumps({k: v for k, v in cfg.items() if not k.startswith("_")}, indent=1))
    made = create_launcher(cfg) if launcher else []
    start(cfg)
    up = wait_until_up(port)
    if browser and up:
        import webbrowser
        webbrowser.open(open_url(cfg))
    return dict(status(cfg), launcher=made, started=up)


def uninstall(cfg: dict, remove_data: bool = False) -> dict:
    """Remove the background service and the launcher. The data directory is kept unless ``remove_data``."""
    unregister(cfg)
    remove_launcher()
    removed = False
    if remove_data:
        shutil.rmtree(cfg["data_dir"], ignore_errors=True)
        removed = True
    else:
        (Path(cfg["data_dir"]) / "installation-home.txt").unlink(missing_ok=True)
    return dict(service_removed=True, launcher_removed=True, data_dir=cfg["data_dir"], data_removed=removed,
                folder=cfg["home"])
