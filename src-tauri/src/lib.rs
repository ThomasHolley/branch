use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

// One shell per terminal tab, keyed by the id start_shell returns.
struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    pid: Option<u32>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Default)]
struct Sessions {
    map: Mutex<HashMap<u32, Arc<Session>>>,
    next_id: AtomicU32,
}

impl Sessions {
    fn get(&self, id: u32) -> Result<Arc<Session>, String> {
        self.map
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| "shell not started".to_string())
    }

    fn pid(&self, id: u32) -> Result<u32, String> {
        self.get(id)?.pid.ok_or_else(|| "shell pid unknown".to_string())
    }
}

#[derive(Clone, Serialize)]
struct PtyData {
    id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: u32,
    code: u32,
}

// Decodes as much of `pending` as possible, keeping a multi-byte character
// split across two reads for the next call instead of turning it into U+FFFD.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(std::str::from_utf8(&pending[..valid]).unwrap_or_default());
                match e.error_len() {
                    Some(len) => {
                        out.push('\u{FFFD}');
                        pending.drain(..valid + len);
                    }
                    None => {
                        pending.drain(..valid);
                        return out;
                    }
                }
            }
        }
    }
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
struct GitStatus {
    branch: Option<String>,
    ahead: i32,
    behind: i32,
    entries: HashMap<String, String>,
    // "merge", "rebase", "cherry-pick" or "revert" while one is waiting to be finished
    operation: Option<String>,
}

// Builds a std Command that doesn't flash a console window on Windows.
fn command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn home_path() -> Option<std::ffi::OsString> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
    }
}

// On Windows there is no lsof: the PowerShell prompt writes its cwd to this file instead.
#[cfg(windows)]
fn cwd_file(id: u32) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("branch-cwd-{}-{}.txt", std::process::id(), id))
}

// Shell integration: each prompt reports its exit code and cwd, and each command its
// text, through a private OSC sequence the front end intercepts:
//   ESC ] 6973 ; prompt ; <code> ; <cwd> BEL      ESC ] 6973 ; cmd ; <text> BEL
// Shells without integration (fish…) fall back to polling ps/lsof.
//
// Wraps the user's prompt so every prompt records the current directory, and Enter
// so every command is reported.
// No double quotes in here: it goes through the Windows command line as a single argument.
#[cfg(windows)]
const PS_INIT: &str = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; \
$OutputEncoding = [Text.Encoding]::UTF8; \
$global:BranchPrompt = $function:prompt; \
function global:prompt { \
$ok = $?; $code = 0; if (-not $ok) { $code = 1; if ($global:LASTEXITCODE) { $code = $global:LASTEXITCODE } }; \
$cwd = $executionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath; \
try { [IO.File]::WriteAllText($env:BRANCH_CWD_FILE, $cwd) } catch {}; \
([char]27 + ']6973;prompt;' + $code + ';' + $cwd + [char]7) + (& $global:BranchPrompt) }; \
try { Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock { \
$line = $null; $cursor = $null; \
[Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor); \
[Console]::Write([char]27 + ']6973;cmd;' + ($line -replace '[\\x07\\x1b]', '') + [char]7); \
[Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine() }; \
Set-PSReadLineKeyHandler -Chord Ctrl+Alt+Shift+F12 -ScriptBlock { \
try { Set-Location -LiteralPath ([IO.File]::ReadAllText($env:BRANCH_CD_FILE)) } catch {}; \
[Microsoft.PowerShell.PSConsoleReadLine]::InvokePrompt() } } catch {}";

#[cfg(not(windows))]
const ZSHENV: &str = include_str!("../shell/zshenv");
#[cfg(not(windows))]
const ZSHRC: &str = include_str!("../shell/zshrc");
#[cfg(not(windows))]
const BASHRC: &str = include_str!("../shell/bashrc");

// Writes the integration scripts to a temp dir and returns it.
#[cfg(not(windows))]
fn integration_dir() -> std::io::Result<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(format!("branch-shell-{}", std::process::id()));
    fs::create_dir_all(&dir)?;
    fs::write(dir.join(".zshenv"), ZSHENV)?;
    fs::write(dir.join(".zshrc"), ZSHRC)?;
    fs::write(dir.join("bashrc"), BASHRC)?;
    Ok(dir)
}

// The locale to give the shell when the app's own environment has no UTF-8 one (an app
// launched from the Finder gets neither LANG nor TERM). Without it zsh counts bytes,
// not characters, and the cursor drifts on accented text.
#[cfg_attr(windows, allow(dead_code))]
fn utf8_lang(current: Option<&str>, system_locale: Option<&str>) -> Option<String> {
    if let Some(current) = current {
        let lower = current.to_lowercase();
        if lower.contains("utf-8") || lower.contains("utf8") {
            return None;
        }
    }
    // macOS AppleLocale looks like "fr_FR" or "fr_FR@rg=bezzzz".
    let base = system_locale
        .and_then(|l| l.split('@').next())
        .map(str::trim)
        .filter(|l| l.len() == 5 && l.as_bytes()[2] == b'_')
        .unwrap_or("en_US");
    Some(format!("{}.UTF-8", base))
}

#[cfg(not(windows))]
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

#[cfg(windows)]
fn default_shell() -> String {
    "powershell.exe".to_string()
}

// The shells offered in the settings.
#[cfg(not(windows))]
fn available_shells() -> Vec<String> {
    let mut shells: Vec<String> = fs::read_to_string("/etc/shells")
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('/') && Path::new(line).exists())
        .map(String::from)
        .collect();
    shells.dedup();
    shells
}

#[cfg(windows)]
fn available_shells() -> Vec<String> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    ["powershell.exe", "pwsh.exe", "cmd.exe"]
        .iter()
        .filter(|name| **name != "pwsh.exe" || find_in_path(name, &path).is_some())
        .map(|name| name.to_string())
        .collect()
}

#[derive(Serialize)]
struct ShellChoices {
    default: String,
    available: Vec<String>,
}

#[tauri::command]
fn shell_choices() -> ShellChoices {
    ShellChoices {
        default: default_shell(),
        available: available_shells(),
    }
}

// `shell` comes from the settings; empty or missing means the user's default shell.
#[cfg(not(windows))]
fn shell_command(shell: Option<String>) -> CommandBuilder {
    let shell = shell
        .filter(|s| !s.is_empty() && Path::new(s).exists())
        .unwrap_or_else(default_shell);
    let name = Path::new(&shell)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut cmd = CommandBuilder::new(&shell);
    // What xterm.js understands. Without TERM, zsh falls back to a "dumb" terminal and
    // redraws the line with spaces instead of moving the cursor.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "branch");
    let current = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .find_map(|var| std::env::var(var).ok().filter(|v| !v.is_empty()));
    let system_locale = command("defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string());
    if let Some(lang) = utf8_lang(current.as_deref(), system_locale.as_deref()) {
        cmd.env("LANG", lang);
        cmd.env_remove("LC_ALL");
        cmd.env_remove("LC_CTYPE");
    }
    let Ok(dir) = integration_dir() else {
        return cmd;
    };
    match name.as_str() {
        "zsh" => {
            if let Some(user_zdotdir) = std::env::var_os("ZDOTDIR") {
                cmd.env("BRANCH_USER_ZDOTDIR", user_zdotdir);
            }
            cmd.env("ZDOTDIR", &dir);
        }
        "bash" => {
            cmd.arg("--rcfile");
            cmd.arg(dir.join("bashrc"));
        }
        _ => {}
    }
    cmd
}

// PowerShell (5 or 7) gets the integration; cmd.exe runs as is.
#[cfg(windows)]
fn shell_command(shell: Option<String>) -> CommandBuilder {
    let shell = shell.filter(|s| !s.is_empty()).unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell);
    let name = Path::new(&shell)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name == "powershell.exe" || name == "pwsh.exe" {
        cmd.args(["-NoLogo", "-NoExit", "-Command", PS_INIT]);
    }
    cmd
}

// A command line run at the prompt. It first clears whatever is already typed
// (Ctrl+U for zsh/bash, Escape for PSReadLine) so it isn't appended to it.
#[cfg(not(windows))]
fn prompt_line(line: &str) -> String {
    format!("\x15{}\n", line)
}

#[cfg(windows)]
fn prompt_line(line: &str) -> String {
    format!("\x1b{}\r", line)
}

// Silent navigation: the path goes through this file and a key the shell integration
// binds (Ctrl+Alt+Shift+F12) makes the shell cd to it without echoing a command line,
// keeping whatever was being typed.
fn cd_file(id: u32) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("branch-cd-{}-{}.txt", std::process::id(), id))
}

const SILENT_CD_KEY: &str = "\x1b[24;8~";

fn remove_session_files(id: u32) {
    let _ = fs::remove_file(cd_file(id));
    #[cfg(windows)]
    let _ = fs::remove_file(cwd_file(id));
}

#[cfg(not(windows))]
fn cd_command(path: &str) -> String {
    let escaped = path.replace('\'', "'\\''");
    prompt_line(&format!("cd '{}' && clear", escaped))
}

#[cfg(windows)]
fn cd_command(path: &str) -> String {
    let escaped = path.replace('\'', "''");
    prompt_line(&format!("Set-Location -LiteralPath '{}'; Clear-Host", escaped))
}

#[cfg(not(windows))]
fn foreground_pgid(pid: u32) -> Result<Option<String>, String> {
    let out = command("ps")
        .args(["-o", "tpgid=", "-p", &pid.to_string()])
        .output()
        .map_err(|e| e.to_string())?;
    let tpgid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if tpgid.is_empty() {
        Ok(None)
    } else {
        Ok(Some(tpgid))
    }
}

// What runs in the foreground of the terminal. `ports` are the TCP ports the foreground
// job listens on: that is how a dev server is recognised, whatever it is written in.
#[derive(Serialize, Default)]
struct ForegroundState {
    name: String,
    command: String,
    ports: Vec<u16>,
}

fn port_of(address: &str) -> Option<u16> {
    address.rsplit(':').next()?.parse().ok()
}

// `lsof -Fn` output: one "n<address>:<port>" line per listening socket.
#[cfg_attr(windows, allow(dead_code))]
fn parse_lsof_ports(output: &str) -> Vec<u16> {
    let mut ports: Vec<u16> = output
        .lines()
        .filter_map(|line| line.strip_prefix('n'))
        .filter_map(port_of)
        .collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

// `netstat -ano` output: "  TCP    0.0.0.0:5173    0.0.0.0:0    LISTENING    1234".
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn parse_netstat_ports(output: &str, pids: &std::collections::HashSet<u32>) -> Vec<u16> {
    let mut ports: Vec<u16> = output
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() == 5 && fields[0] == "TCP" && fields[3] == "LISTENING" {
                let pid: u32 = fields[4].parse().ok()?;
                if pids.contains(&pid) {
                    return port_of(fields[1]);
                }
            }
            None
        })
        .collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

#[cfg(not(windows))]
fn foreground_state_of(shell_pid: u32) -> Result<ForegroundState, String> {
    let Some(tpgid) = foreground_pgid(shell_pid)? else {
        return Ok(ForegroundState::default());
    };

    let comm_out = command("ps")
        .args(["-o", "comm=", "-p", &tpgid])
        .output()
        .map_err(|e| e.to_string())?;
    let comm = String::from_utf8_lossy(&comm_out.stdout).trim().to_string();
    let name = comm.rsplit('/').next().unwrap_or(&comm).to_string();

    let args_out = command("ps")
        .args(["-o", "args=", "-p", &tpgid])
        .output()
        .map_err(|e| e.to_string())?;
    let command_line = String::from_utf8_lossy(&args_out.stdout).trim().to_string();

    // The shell itself is in the foreground: nothing to look for.
    if tpgid == shell_pid.to_string() {
        return Ok(ForegroundState { name, command: command_line, ports: Vec::new() });
    }

    // Every process of the foreground job (npm → sh → node for `npm run dev`).
    let pgrep_out = command("pgrep").args(["-g", &tpgid]).output().map_err(|e| e.to_string())?;
    let pids = String::from_utf8_lossy(&pgrep_out.stdout)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(",");
    let ports = if pids.is_empty() {
        Vec::new()
    } else {
        let lsof_out = command("lsof")
            .args(["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", &pids, "-Fn"])
            .output()
            .map_err(|e| e.to_string())?;
        parse_lsof_ports(&String::from_utf8_lossy(&lsof_out.stdout))
    };

    Ok(ForegroundState { name, command: command_line, ports })
}

// Windows has no foreground process group: follow the most recent child chain from the shell
// for the name, and look at every descendant of the shell for listening ports.
#[cfg(windows)]
fn foreground_state_of(shell_pid: u32) -> Result<ForegroundState, String> {
    use std::collections::HashSet;
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );

    let shell = Pid::from_u32(shell_pid);
    let mut current = shell;
    for _ in 0..32 {
        let child = sys
            .processes()
            .values()
            .filter(|p| p.parent() == Some(current))
            .filter(|p| !p.name().eq_ignore_ascii_case("conhost.exe"))
            .max_by_key(|p| p.start_time());
        match child {
            Some(p) => current = p.pid(),
            None => break,
        }
    }
    if current == shell {
        return Ok(ForegroundState::default());
    }
    let Some(process) = sys.process(current) else {
        return Ok(ForegroundState::default());
    };

    let command_line = process
        .cmd()
        .iter()
        .map(|a| a.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(" ");
    let raw = process.name().to_string_lossy().to_lowercase();
    let mut name = raw.strip_suffix(".exe").unwrap_or(&raw).to_string();
    // Claude Code installed through npm runs as node.exe
    if command_line.contains("claude-code") {
        name = "claude".to_string();
    }

    let mut descendants: HashSet<u32> = HashSet::new();
    let mut frontier = vec![shell];
    while let Some(parent) = frontier.pop() {
        for p in sys.processes().values().filter(|p| p.parent() == Some(parent)) {
            if descendants.insert(p.pid().as_u32()) {
                frontier.push(p.pid());
            }
        }
    }
    let ports = command("netstat")
        .args(["-ano", "-p", "TCP"])
        .output()
        .map(|out| parse_netstat_ports(&String::from_utf8_lossy(&out.stdout), &descendants))
        .unwrap_or_default();
    // IPv6 sockets are listed separately.
    let ports_v6 = command("netstat")
        .args(["-ano", "-p", "TCPv6"])
        .output()
        .map(|out| parse_netstat_ports(&String::from_utf8_lossy(&out.stdout), &descendants))
        .unwrap_or_default();
    let mut ports: Vec<u16> = ports.into_iter().chain(ports_v6).collect();
    ports.sort_unstable();
    ports.dedup();

    Ok(ForegroundState { name, command: command_line, ports })
}

// Starts a new shell in `cwd` (the home folder if missing or gone), at the given
// terminal size, and returns its id.
#[tauri::command]
fn start_shell(
    app: tauri::AppHandle,
    state: State<Sessions>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    // Opened at the terminal's real size: a shell started at 80x24 and resized right
    // after draws its first prompt for the wrong width (zsh then shows a stray "%").
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.filter(|&r| r > 0).unwrap_or(24),
            cols: cols.filter(|&c| c > 0).unwrap_or(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let mut cmd = shell_command(shell);
    #[cfg(windows)]
    cmd.env("BRANCH_CWD_FILE", cwd_file(id));
    cmd.env("BRANCH_CD_FILE", cd_file(id));
    let start_dir = cwd
        .filter(|dir| Path::new(dir).is_dir())
        .map(std::ffi::OsString::from)
        .or_else(home_path);
    if let Some(dir) = start_dir {
        cmd.cwd(dir);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let session = Session {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        pid: child.process_id(),
        killer: Mutex::new(child.clone_killer()),
    };
    state.map.lock().unwrap().insert(id, Arc::new(session));

    let reader_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let data = take_utf8(&mut pending);
                    if !data.is_empty() && reader_app.emit("pty-data", PtyData { id, data }).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // The reader doesn't always see EOF when the shell exits (ConPTY keeps the pipe open),
    // so wait on the child itself and tell the front end.
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        // Already gone if the tab was closed: nobody to tell.
        let removed = app.state::<Sessions>().map.lock().unwrap().remove(&id);
        remove_session_files(id);
        if removed.is_some() {
            let _ = app.emit("pty-exit", PtyExit { id, code });
        }
    });

    Ok(id)
}

#[tauri::command]
fn close_shell(id: u32, state: State<Sessions>) -> Result<(), String> {
    if let Some(session) = state.map.lock().unwrap().remove(&id) {
        let _ = session.killer.lock().unwrap().kill();
    }
    remove_session_files(id);
    Ok(())
}

// A reload of the webview starts over: the shells of the previous page must not linger.
#[tauri::command]
fn close_all_shells(state: State<Sessions>) -> Result<(), String> {
    for (_, session) in state.map.lock().unwrap().drain() {
        let _ = session.killer.lock().unwrap().kill();
    }
    Ok(())
}

#[tauri::command]
fn write_to_pty(id: u32, data: String, state: State<Sessions>) -> Result<(), String> {
    let session = state.get(id)?;
    let mut writer = session.writer.lock().unwrap();
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn resize_pty(id: u32, cols: u16, rows: u16, state: State<Sessions>) -> Result<(), String> {
    let session = state.get(id)?;
    let master = session.master.lock().unwrap();
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

// `silent` when the shell integration is active (it binds SILENT_CD_KEY); otherwise a
// visible cd command is typed.
#[tauri::command]
fn cd_to(id: u32, path: String, silent: bool, state: State<Sessions>) -> Result<(), String> {
    if silent {
        fs::write(cd_file(id), &path).map_err(|e| e.to_string())?;
        write_to_pty(id, SILENT_CD_KEY.to_string(), state)
    } else {
        write_to_pty(id, cd_command(&path), state)
    }
}

#[tauri::command]
fn run_at_prompt(id: u32, line: String, state: State<Sessions>) -> Result<(), String> {
    write_to_pty(id, prompt_line(&line), state)
}

fn is_hidden(entry: &fs::DirEntry, file_name: &str) -> bool {
    if file_name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if let Ok(meta) = entry.metadata() {
            return meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
        }
    }
    #[cfg(not(windows))]
    let _ = entry;
    false
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut entries: Vec<DirEntry> = dir
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if is_hidden(&entry, &file_name) {
                return None;
            }
            let path = entry.path();
            let is_dir = path.is_dir();
            Some(DirEntry {
                name: file_name,
                path: path.to_string_lossy().to_string(),
                is_dir,
            })
        })
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
async fn foreground_state(id: u32, state: State<'_, Sessions>) -> Result<ForegroundState, String> {
    foreground_state_of(state.pid(id)?)
}

#[tauri::command]
async fn shell_cwd(id: u32, state: State<'_, Sessions>) -> Result<String, String> {
    #[cfg(windows)]
    {
        state.get(id)?;
        let cwd = fs::read_to_string(cwd_file(id)).map_err(|_| "cwd not found".to_string())?;
        let cwd = cwd.trim();
        if cwd.is_empty() {
            Err("cwd not found".to_string())
        } else {
            Ok(cwd.to_string())
        }
    }

    #[cfg(not(windows))]
    {
        let pid = state.pid(id)?;
        let out = command("lsof")
            .args(["-a", "-d", "cwd", "-p", &pid.to_string(), "-Fn"])
            .output()
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if let Some(path) = line.strip_prefix('n') {
                return Ok(path.to_string());
            }
        }
        Err("cwd not found".to_string())
    }
}

#[tauri::command]
fn home_dir() -> Result<String, String> {
    home_path()
        .map(|h| h.to_string_lossy().to_string())
        .ok_or_else(|| "home directory not set".to_string())
}

#[tauri::command]
fn parent_dir(path: String) -> Result<String, String> {
    Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "no parent".to_string())
}

#[tauri::command]
async fn dir_size(path: String) -> Result<u64, String> {
    fn walk(path: &Path, budget: &mut u32) -> u64 {
        if *budget == 0 {
            return 0;
        }
        let mut total = 0u64;
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.filter_map(|e| e.ok()) {
                if *budget == 0 {
                    break;
                }
                *budget -= 1;
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if meta.is_dir() {
                    total += walk(&entry.path(), budget);
                } else {
                    total += meta.len();
                }
            }
        }
        total
    }

    let mut budget: u32 = 50_000;
    Ok(walk(Path::new(&path), &mut budget))
}

// Editors offered in the settings. On macOS an editor is found by its command line
// launcher or, failing that, by its application bundle: VS Code's `code` command is
// only there once installed from VS Code itself.
struct Editor {
    id: &'static str,
    label: &'static str,
    cli: &'static str,
    windows_cli: Option<&'static str>,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    mac_app: &'static str,
}

const EDITORS: [Editor; 4] = [
    Editor { id: "vscode", label: "VS Code", cli: "code", windows_cli: Some("code.cmd"), mac_app: "Visual Studio Code.app" },
    Editor { id: "cursor", label: "Cursor", cli: "cursor", windows_cli: Some("cursor.cmd"), mac_app: "Cursor.app" },
    Editor { id: "zed", label: "Zed", cli: "zed", windows_cli: None, mac_app: "Zed.app" },
    Editor { id: "sublime", label: "Sublime Text", cli: "subl", windows_cli: Some("subl.exe"), mac_app: "Sublime Text.app" },
];

enum Launcher {
    Cli(std::path::PathBuf),
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    MacApp(std::path::PathBuf),
}

fn find_in_path(name: &str, path_var: &std::ffi::OsStr) -> Option<std::path::PathBuf> {
    std::env::split_paths(path_var)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

// /Applications, then ~/Applications.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn find_mac_app(bundle: &str, home: Option<&Path>) -> Option<std::path::PathBuf> {
    let mut dirs = vec![std::path::PathBuf::from("/Applications")];
    if let Some(home) = home {
        dirs.push(home.join("Applications"));
    }
    dirs.into_iter().map(|dir| dir.join(bundle)).find(|app| app.is_dir())
}

fn editor_launcher(editor: &Editor) -> Option<Launcher> {
    let cli = if cfg!(windows) { editor.windows_cli } else { Some(editor.cli) };
    if let Some(found) = cli.and_then(|cli| find_in_path(cli, &std::env::var_os("PATH").unwrap_or_default())) {
        return Some(Launcher::Cli(found));
    }
    #[cfg(target_os = "macos")]
    {
        let home = home_path().map(std::path::PathBuf::from);
        if let Some(app) = find_mac_app(editor.mac_app, home.as_deref()) {
            return Some(Launcher::MacApp(app));
        }
    }
    None
}

fn launch(launcher: &Launcher, path: &str) -> bool {
    let status = match launcher {
        Launcher::Cli(cli) => command(&cli.to_string_lossy()).arg(path).status(),
        Launcher::MacApp(app) => command("open").arg("-a").arg(app).arg(path).status(),
    };
    matches!(status, Ok(s) if s.success())
}

#[derive(Serialize)]
struct EditorChoice {
    id: String,
    label: String,
}

// The installed editors, then the system's default application.
#[tauri::command]
async fn list_editors() -> Vec<EditorChoice> {
    let mut choices: Vec<EditorChoice> = EDITORS
        .iter()
        .filter(|editor| editor_launcher(editor).is_some())
        .map(|editor| EditorChoice { id: editor.id.to_string(), label: editor.label.to_string() })
        .collect();
    choices.push(EditorChoice {
        id: "system".to_string(),
        label: "Application par défaut".to_string(),
    });
    choices
}

// Opens with the editor chosen in the settings, or the default application when it
// is "system" or not installed.
#[tauri::command]
async fn open_in_editor(app: tauri::AppHandle, path: String, editor: Option<String>) -> Result<(), String> {
    let wanted = editor.unwrap_or_else(|| "vscode".to_string());
    if let Some(launcher) = EDITORS.iter().find(|e| e.id == wanted).and_then(editor_launcher) {
        if launch(&launcher, &path) {
            return Ok(());
        }
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| e.to_string())
}

// Refuses what no click in the tree should ever delete: a filesystem root, the home
// folder or one of its ancestors, or a relative path.
fn check_deletable(path: &Path, home: Option<&Path>) -> Result<(), String> {
    if !path.is_absolute() || path.parent().is_none() {
        return Err("chemin refusé".to_string());
    }
    if let Some(home) = home {
        if home.starts_with(path) {
            return Err("le dossier personnel et ses parents ne peuvent pas être supprimés".to_string());
        }
    }
    Ok(())
}

// To the Trash / Recycle Bin, so a wrong click can be undone.
#[tauri::command]
async fn delete_path(path: String) -> Result<(), String> {
    let home = home_path().map(std::path::PathBuf::from);
    check_deletable(Path::new(&path), home.as_deref())?;
    trash::delete(&path).map_err(|e| e.to_string())
}

// Folders the filter doesn't descend into: huge, generated, rarely what is looked for.
const SKIPPED_DIRS: [&str; 5] = ["node_modules", "target", "dist", "build", "vendor"];

// Recursive, case-insensitive name search under `root`, breadth first so that the
// closest matches come first. Bounded in results and in folders visited.
fn search_files(root: &Path, query: &str, limit: usize) -> Vec<DirEntry> {
    let query = query.to_lowercase();
    let mut results = Vec::new();
    let mut queue = std::collections::VecDeque::from([root.to_path_buf()]);
    let mut budget = 20_000u32;
    while let Some(dir) = queue.pop_front() {
        let Ok(read) = fs::read_dir(&dir) else { continue };
        let mut entries: Vec<fs::DirEntry> = read.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
        for entry in entries {
            if budget == 0 || results.len() >= limit {
                return results;
            }
            budget -= 1;
            let name = entry.file_name().to_string_lossy().to_string();
            if is_hidden(&entry, &name) {
                continue;
            }
            let path = entry.path();
            // file_type doesn't follow symlinks: no loops through a linked folder.
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if name.to_lowercase().contains(&query) {
                results.push(DirEntry {
                    name,
                    path: path.to_string_lossy().to_string(),
                    is_dir,
                });
            } else if is_dir && SKIPPED_DIRS.contains(&name.as_str()) {
                continue;
            }
            if is_dir {
                queue.push_back(path);
            }
        }
    }
    results
}

#[tauri::command]
async fn find_files(root: String, query: String) -> Result<Vec<DirEntry>, String> {
    Ok(search_files(Path::new(&root), &query, 200))
}

// git prints forward slashes; on Windows the tree uses backslashes, so the keys must match.
fn repo_path(base: &str, relative: &str) -> String {
    let full = Path::new(base).join(relative).to_string_lossy().to_string();
    if cfg!(windows) {
        full.replace('/', "\\")
    } else {
        full
    }
}

// Parses `git status --porcelain=v2 --branch -z`. git paths are relative to the
// repository root; `prefix` (from `rev-parse --show-prefix`) is where `base` sits in
// the repo, so keys are built from `base` itself and match the tree even through
// symlinks. Files outside `base` are left out.
fn parse_porcelain(output: &str, base: &str, prefix: &str) -> GitStatus {
    let mut branch = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut entries = HashMap::new();
    let mut add = |path: &str, code: &str| {
        if let Some(relative) = path.strip_prefix(prefix) {
            entries.insert(repo_path(base, relative), code.to_string());
        }
    };

    let mut records = output.split('\0');
    while let Some(record) = records.next() {
        if let Some(rest) = record.strip_prefix("# branch.head ") {
            if rest != "(detached)" {
                branch = Some(rest.to_string());
            }
        } else if let Some(rest) = record.strip_prefix("# branch.ab ") {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() == 2 {
                ahead = parts[0].trim_start_matches('+').parse().unwrap_or(0);
                behind = parts[1].trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if let Some(rest) = record.strip_prefix("1 ") {
            // "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>": the path may contain spaces
            let fields: Vec<&str> = rest.splitn(8, ' ').collect();
            if fields.len() == 8 {
                add(fields[7], fields[0]);
            }
        } else if let Some(rest) = record.strip_prefix("2 ") {
            // rename/copy: one more field (<X><score>), then the original path as its own record
            let fields: Vec<&str> = rest.splitn(9, ' ').collect();
            if fields.len() == 9 {
                add(fields[8], fields[0]);
            }
            records.next();
        } else if let Some(rest) = record.strip_prefix("u ") {
            // unmerged: "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
            let fields: Vec<&str> = rest.splitn(10, ' ').collect();
            if fields.len() == 10 {
                add(fields[9], "UU");
            }
        } else if let Some(rest) = record.strip_prefix("? ") {
            add(rest, "??");
        }
    }

    GitStatus {
        branch,
        ahead,
        behind,
        entries,
        operation: None,
    }
}

// The marker files git leaves in the git dir while an operation is paused.
fn git_operation(git_dir: &Path) -> Option<String> {
    [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ]
    .iter()
    .find(|(marker, _)| git_dir.join(marker).exists())
    .map(|(_, name)| name.to_string())
}

#[tauri::command]
async fn git_status(path: String) -> Result<GitStatus, String> {
    let out = command("git")
        .args(["-C", &path, "status", "--porcelain=v2", "--branch", "-z"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("not a git repository".to_string());
    }

    // One line each, in this order; the prefix line is empty at the repo root.
    let rev_out = command("git")
        .args(["-C", &path, "rev-parse", "--git-dir", "--show-prefix"])
        .output()
        .map_err(|e| e.to_string())?;
    let rev = String::from_utf8_lossy(&rev_out.stdout).to_string();
    let mut lines = rev.lines();
    let git_dir = Path::new(&path).join(lines.next().unwrap_or(".git").trim());
    let prefix = lines.next().unwrap_or("").trim().to_string();

    let mut status = parse_porcelain(&String::from_utf8_lossy(&out.stdout), &path, &prefix);
    status.operation = git_operation(&git_dir);
    Ok(status)
}

// Text between two markers, to ignore whatever the shell's startup files print.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn between_markers<'a>(output: &'a str, marker: &str) -> Option<&'a str> {
    let start = output.find(marker)? + marker.len();
    let end = start + output[start..].find(marker)?;
    Some(&output[start..end])
}

// An app opened from the Finder gets launchd's minimal PATH (/usr/bin:/bin:…), without
// Homebrew, npm or the editors' launchers. Take the PATH of the user's login shell,
// as Terminal.app would have it.
#[cfg(target_os = "macos")]
fn adopt_login_shell_path() {
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    const MARKER: &str = "__BRANCH_PATH__";
    let script = format!("printf '{MARKER}%s{MARKER}' \"$PATH\"");
    let Ok(mut child) = std::process::Command::new(default_shell())
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    // A shell config waiting for input must not block the app's start.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return;
            }
        }
    }
    let mut output = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut output);
    }
    if let Some(path) = between_markers(&output, MARKER).filter(|p| !p.is_empty()) {
        // SAFETY: called first thing in run(), before any other thread exists.
        unsafe { std::env::set_var("PATH", path) };
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    adopt_login_shell_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Sessions::default())
        .invoke_handler(tauri::generate_handler![
            start_shell,
            shell_choices,
            list_editors,
            close_shell,
            close_all_shells,
            write_to_pty,
            resize_pty,
            cd_to,
            run_at_prompt,
            list_dir,
            home_dir,
            parent_dir,
            foreground_state,
            shell_cwd,
            dir_size,
            open_in_editor,
            delete_path,
            find_files,
            git_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_split_across_reads() {
        let bytes = "é".as_bytes();
        let mut pending = vec![b'a', bytes[0]];
        assert_eq!(take_utf8(&mut pending), "a");
        pending.push(bytes[1]);
        assert_eq!(take_utf8(&mut pending), "é");
        assert!(pending.is_empty());
    }

    #[test]
    fn utf8_invalid_byte_is_replaced() {
        let mut pending = vec![b'a', 0xff, b'b'];
        assert_eq!(take_utf8(&mut pending), "a\u{FFFD}b");
        assert!(pending.is_empty());
    }

    #[test]
    fn porcelain_spaces_renames_and_prefix() {
        let output = [
            "# branch.oid abc",
            "# branch.head main",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 aaa bbb src/mon fichier.js",
            "2 R. N... 100644 100644 100644 aaa bbb R100 src/nouveau.js",
            "src/ancien.js",
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflit.js",
            "? src/neuf dossier/a.txt",
            "? README.md",
            "",
        ]
        .join("\0");
        let status = parse_porcelain(&output, "/repo/src", "src/");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        let key = |p: &str| repo_path("/repo/src", p);
        assert_eq!(status.entries.get(&key("mon fichier.js")).map(String::as_str), Some(".M"));
        assert_eq!(status.entries.get(&key("nouveau.js")).map(String::as_str), Some("R."));
        assert_eq!(status.entries.get(&key("conflit.js")).map(String::as_str), Some("UU"));
        assert_eq!(status.entries.get(&key("neuf dossier/a.txt")).map(String::as_str), Some("??"));
        // outside the requested folder, and the rename's original path is not an entry
        assert_eq!(status.entries.len(), 4);
    }

    #[test]
    fn utf8_locale_only_when_missing() {
        assert_eq!(utf8_lang(Some("fr_FR.UTF-8"), Some("fr_FR")), None);
        assert_eq!(utf8_lang(Some("C.utf8"), None), None);
        assert_eq!(utf8_lang(None, Some("fr_FR")).as_deref(), Some("fr_FR.UTF-8"));
        assert_eq!(utf8_lang(Some("C"), Some("de_DE@rg=frzzzz")).as_deref(), Some("de_DE.UTF-8"));
        assert_eq!(utf8_lang(None, Some("fr")).as_deref(), Some("en_US.UTF-8"));
        assert_eq!(utf8_lang(None, None).as_deref(), Some("en_US.UTF-8"));
    }

    #[test]
    #[cfg(not(windows))]
    fn deletion_guard() {
        let home = Path::new("/Users/me");
        assert!(check_deletable(Path::new("/Users/me/projet/a.txt"), Some(home)).is_ok());
        assert!(check_deletable(Path::new("/"), Some(home)).is_err());
        assert!(check_deletable(Path::new("/Users"), Some(home)).is_err());
        assert!(check_deletable(Path::new("/Users/me"), Some(home)).is_err());
        assert!(check_deletable(Path::new("projet"), Some(home)).is_err());
    }

    #[test]
    fn markers() {
        assert_eq!(between_markers("motd\n__M__/usr/bin:/bin__M__", "__M__"), Some("/usr/bin:/bin"));
        assert_eq!(between_markers("__M__unterminated", "__M__"), None);
    }

    #[test]
    fn path_lookup() {
        let dir = std::env::temp_dir().join(format!("branch-path-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("fake-editor"), "").unwrap();
        let path_var = std::env::join_paths([Path::new("/nonexistent"), dir.as_path()]).unwrap();
        assert_eq!(find_in_path("fake-editor", &path_var), Some(dir.join("fake-editor")));
        assert_eq!(find_in_path("absent", &path_var), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn mac_app_lookup() {
        let home = std::env::temp_dir().join(format!("branch-apps-{}", std::process::id()));
        fs::create_dir_all(home.join("Applications/Fake Editor.app")).unwrap();
        assert_eq!(
            find_mac_app("Fake Editor.app", Some(&home)),
            Some(home.join("Applications/Fake Editor.app"))
        );
        assert_eq!(find_mac_app("Absent.app", Some(&home)), None);
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn lsof_ports() {
        let output = "p123\nf10\nn*:5173\nf11\nn[::1]:5173\np124\nf3\nn127.0.0.1:24678\n";
        assert_eq!(parse_lsof_ports(output), vec![5173, 24678]);
    }

    #[test]
    fn netstat_ports() {
        let output = "\nActive Connections\n\n  Proto  Local Address          Foreign Address        State           PID\n  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       900\n  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242\n  TCP    [::1]:3000             [::]:0                 LISTENING       4243\n  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     4242\n";
        let pids = [4242, 4243].into_iter().collect();
        assert_eq!(parse_netstat_ports(output, &pids), vec![3000, 5173]);
    }

    #[test]
    fn search_is_recursive_and_skips_generated_folders() {
        let root = std::env::temp_dir().join(format!("branch-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src/components")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("src/components/Button.js"), "").unwrap();
        fs::write(root.join("node_modules/pkg/button.js"), "").unwrap();
        fs::write(root.join(".git/button"), "").unwrap();
        fs::write(root.join("button.md"), "").unwrap();

        let names: Vec<String> = search_files(&root, "BUTTON", 10).into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["button.md", "Button.js"]);
        fs::remove_dir_all(&root).unwrap();
    }
}
