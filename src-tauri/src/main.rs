use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const DEFAULT_SOURCE: &str = "/Applications/WeChat.app";
const CONFIG_FILE: &str = "profiles.json";
const SETTINGS_FILE: &str = "settings.json";
const LOG_DIR_NAME: &str = "com.richqaq.wxclone";
const LOG_FILE_NAME: &str = "wxclone.log";
const UPDATE_CHECK_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CloneProfile {
    id: String,
    name: String,
    bundle_id: String,
    source_path: String,
    #[serde(default = "default_install_dir")]
    install_dir: String,
    enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppSettings {
    install_dir: String,
    base_name: String,
    base_bundle_id: String,
    source_path: String,
}

#[derive(Debug, Clone, Serialize)]
struct EnvironmentInfo {
    source_path: String,
    source_exists: bool,
    source_bundle_id: Option<String>,
    source_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct OperationResult {
    app_path: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct ConflictInfo {
    app_path: String,
    target_exists: bool,
    bundle_id_at_target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct IconInfo {
    data_url: String,
}

#[derive(Debug, Clone, Serialize)]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    latest_url: String,
    has_update: bool,
}

#[tauri::command]
fn get_environment(source_path: Option<String>) -> EnvironmentInfo {
    let source_path = source_path
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| DEFAULT_SOURCE.to_string());
    let info_plist = Path::new(&source_path).join("Contents/Info.plist");
    let source_exists = Path::new(&source_path).is_dir();

    EnvironmentInfo {
        source_path,
        source_exists,
        source_bundle_id: plist_value(&info_plist, "CFBundleIdentifier"),
        source_version: plist_value(&info_plist, "CFBundleShortVersionString")
            .or_else(|| plist_value(&info_plist, "CFBundleVersion")),
    }
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
async fn check_for_update() -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(check_for_update_with_timeout)
        .await
        .map_err(|err| err.to_string())?
}

fn check_for_update_with_timeout() -> Result<UpdateInfo, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(check_for_update_blocking());
    });

    rx.recv_timeout(Duration::from_secs(UPDATE_CHECK_TIMEOUT_SECS))
        .unwrap_or_else(|_| Err("版本检查超时，请稍后重试或直接打开 GitHub Releases。".to_string()))
}

fn check_for_update_blocking() -> Result<UpdateInfo, String> {
    let output = Command::new("/usr/bin/curl")
        .arg("-sSL")
        .arg("--connect-timeout")
        .arg("5")
        .arg("--max-time")
        .arg("12")
        .arg("--retry")
        .arg("0")
        .arg("-H")
        .arg("Accept: application/vnd.github+json")
        .arg("-H")
        .arg("User-Agent: WxClone")
        .arg("-w")
        .arg("\n__WXCLONE_HTTP_STATUS__:%{http_code}")
        .arg("https://api.github.com/repos/RICHQAQ/WxClone/releases/latest")
        .output()
        .map_err(|err| err.to_string())?;

    if !output.status.success() {
        return Err(command_error(output.stderr));
    }

    let response = String::from_utf8_lossy(&output.stdout);
    let marker = "\n__WXCLONE_HTTP_STATUS__:";
    let Some((body, status)) = response.rsplit_once(marker) else {
        return Err("无法读取 GitHub 响应状态".to_string());
    };
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    if status.trim() == "404" {
        return Ok(UpdateInfo {
            current_version: current_version.clone(),
            latest_version: current_version,
            latest_url: "https://github.com/RICHQAQ/WxClone/releases".to_string(),
            has_update: false,
        });
    }
    if !status.trim().starts_with('2') {
        return Err(format!("GitHub 请求失败，HTTP {}", status.trim()));
    }

    let data: serde_json::Value = serde_json::from_str(body).map_err(|err| err.to_string())?;
    let tag_name = data
        .get("tag_name")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "无法读取最新版本号".to_string())?;
    let latest_url = data
        .get("html_url")
        .and_then(|value| value.as_str())
        .unwrap_or("https://github.com/RICHQAQ/WxClone/releases/latest");
    let latest_version = tag_name.trim_start_matches('v').to_string();

    Ok(UpdateInfo {
        has_update: version_greater_than(&latest_version, &current_version),
        current_version,
        latest_version,
        latest_url: latest_url.to_string(),
    })
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("只允许打开 http/https 链接".to_string());
    }

    let output = Command::new("/usr/bin/open")
        .arg(url)
        .output()
        .map_err(|err| err.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(output.stderr))
    }
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        let defaults = default_settings();
        save_settings_to_path(&path, &defaults)?;
        return Ok(defaults);
    }

    let data = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let settings: AppSettings = serde_json::from_str(&data).map_err(|err| err.to_string())?;
    normalize_settings(settings)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    let settings = normalize_settings(settings)?;
    let path = settings_path(&app)?;
    save_settings_to_path(&path, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn load_profiles(app: tauri::AppHandle) -> Result<Vec<CloneProfile>, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        save_profiles_to_path(&path, &[])?;
        return Ok(Vec::new());
    }

    let data = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&data).map_err(|err| err.to_string())
}

#[tauri::command]
fn save_profiles(
    app: tauri::AppHandle,
    profiles: Vec<CloneProfile>,
) -> Result<Vec<CloneProfile>, String> {
    let normalized = normalize_profiles(profiles)?;
    let path = config_path(&app)?;
    save_profiles_to_path(&path, &normalized)?;
    Ok(normalized)
}

#[tauri::command]
async fn sync_profile(profile: CloneProfile) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || sync_profile_blocking(profile))
        .await
        .map_err(|err| err.to_string())?
}

fn sync_profile_blocking(profile: CloneProfile) -> Result<OperationResult, String> {
    let profile = normalize_profile(profile)?;
    let app_path = app_path_for(&profile.install_dir, &profile.name);
    let script = format!(
        r#"#!/bin/sh
set -u
SRC={source}
DEST={dest}
BUNDLE_ID={bundle_id}
APP_NAME={app_name}

log() {{
  printf '[WxClone] %s\n' "$1"
}}

fail() {{
  printf '[WxClone][ERROR] %s\n' "$1" >&2
  exit "$2"
}}

log "start create/sync"
log "source app: ${{SRC}}"
log "target app: ${{DEST}}"
log "Bundle ID: $BUNDLE_ID"

if [ ! -d "$SRC" ]; then
  fail "source app not found: ${{SRC}}" 10
fi

DEST_PARENT=$(dirname "$DEST")
log "check target dir: ${{DEST_PARENT}}"
mkdir -p "$DEST_PARENT" 2>/dev/null || {{
  fail "cannot create target dir: ${{DEST_PARENT}}" 11
}}

WRITE_TEST="$DEST_PARENT/.wxclone-write-test-$$"
touch "$WRITE_TEST" 2>/dev/null || {{
  fail "target dir is not writable: ${{DEST_PARENT}}. Use /Applications or check disk/folder permissions." 12
}}
rm -f "$WRITE_TEST"

if [ -d "$DEST" ]; then
  log "target exists, check Bundle ID"
  EXISTING_BUNDLE=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$DEST/Contents/Info.plist" 2>/dev/null || true)
  if [ "$EXISTING_BUNDLE" != "$BUNDLE_ID" ]; then
    fail "target path already contains another app: ${{DEST}} (${{EXISTING_BUNDLE}})" 20
  fi
  log "remove old clone"
  rm -rf "$DEST"
fi

log "copy app bundle"
cp -R "$SRC" "$DEST" || {{
  fail "copy failed: ${{SRC}} -> ${{DEST}}" 30
}}
log "set Bundle ID"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$DEST/Contents/Info.plist" || {{
  fail "failed to set Bundle ID: ${{DEST}}/Contents/Info.plist" 31
}}
log "set display name"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" "$DEST/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_NAME" "$DEST/Contents/Info.plist" || true
log "set localized display names"
find "$DEST/Contents/Resources" -name InfoPlist.strings -type f -print 2>/dev/null | while IFS= read -r STRINGS_FILE
do
  log "update localized plist: $STRINGS_FILE"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" "$STRINGS_FILE" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleName string $APP_NAME" "$STRINGS_FILE" || \
    fail "failed to set localized CFBundleName: $STRINGS_FILE" 33
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_NAME" "$STRINGS_FILE" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $APP_NAME" "$STRINGS_FILE" || \
    fail "failed to set localized CFBundleDisplayName: $STRINGS_FILE" 34
done
log "codesign"
/usr/bin/codesign --force --deep --sign - "$DEST" || {{
  fail "codesign failed: ${{DEST}}" 32
}}
log "clear quarantine attributes"
/usr/bin/xattr -cr "$DEST" || true
log "done: ${{DEST}}"
"#,
        source = shell_quote(&profile.source_path),
        dest = shell_quote(&app_path),
        bundle_id = shell_quote(&profile.bundle_id),
        app_name = shell_quote(&profile.name),
    );

    let output = run_admin_script(&script)?;
    Ok(OperationResult {
        app_path,
        message: output.trim().to_string(),
    })
}

#[tauri::command]
async fn sync_all(profiles: Vec<CloneProfile>) -> Result<Vec<OperationResult>, String> {
    tauri::async_runtime::spawn_blocking(move || sync_all_blocking(profiles))
        .await
        .map_err(|err| err.to_string())?
}

fn sync_all_blocking(profiles: Vec<CloneProfile>) -> Result<Vec<OperationResult>, String> {
    let mut results = Vec::new();
    for profile in normalize_profiles(profiles)?
        .into_iter()
        .filter(|item| item.enabled)
    {
        results.push(sync_profile_blocking(profile)?);
    }
    Ok(results)
}

#[tauri::command]
fn launch_profile(profile: CloneProfile) -> Result<(), String> {
    let profile = normalize_profile(profile)?;
    let app_path = app_path_for(&profile.install_dir, &profile.name);
    if !Path::new(&app_path).is_dir() {
        return Err(format!("未找到应用: {app_path}"));
    }

    let output = Command::new("open")
        .arg("-n")
        .arg(&app_path)
        .output()
        .map_err(|err| err.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(output.stderr))
    }
}

#[tauri::command]
async fn remove_profile_app(profile: CloneProfile) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_profile_app_blocking(profile))
        .await
        .map_err(|err| err.to_string())?
}

fn remove_profile_app_blocking(profile: CloneProfile) -> Result<(), String> {
    let profile = normalize_profile(profile)?;
    let app_path = app_path_for(&profile.install_dir, &profile.name);
    let script = format!(
        r#"#!/bin/sh
set -eu
DEST={dest}
if [ -d "$DEST" ]; then
  rm -rf "$DEST"
fi
"#,
        dest = shell_quote(&app_path),
    );
    run_admin_script(&script)?;
    Ok(())
}

#[tauri::command]
async fn choose_source_app() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(choose_source_app_blocking)
        .await
        .map_err(|err| err.to_string())?
}

fn choose_source_app_blocking() -> Result<Option<String>, String> {
    let script = r#"try
  POSIX path of (choose file with prompt "选择微信源应用" of type {"app"})
on error number -128
  return ""
end try"#;
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|err| err.to_string())?;

    if !output.status.success() {
        return Err(command_error(output.stderr));
    }
    let value = String::from_utf8_lossy(&output.stdout)
        .trim()
        .trim_end_matches('/')
        .to_string();
    if value.is_empty() {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

#[tauri::command]
fn reveal_profile_app(profile: CloneProfile) -> Result<(), String> {
    let profile = normalize_profile(profile)?;
    let app_path = app_path_for(&profile.install_dir, &profile.name);
    if !Path::new(&app_path).exists() {
        return Err(format!("目标应用还不存在: {app_path}"));
    }

    let output = Command::new("open")
        .arg("-R")
        .arg(&app_path)
        .output()
        .map_err(|err| err.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(output.stderr))
    }
}

#[tauri::command]
fn get_app_icon(app: tauri::AppHandle, app_path: String) -> Result<Option<IconInfo>, String> {
    let app_path = app_path.trim().trim_end_matches('/').to_string();
    if !app_path.ends_with(".app") || !Path::new(&app_path).is_dir() {
        return Ok(None);
    }

    let info_plist = Path::new(&app_path).join("Contents/Info.plist");
    let Some(icon_file) = plist_value(&info_plist, "CFBundleIconFile") else {
        return Ok(None);
    };

    let icon_name = if icon_file.ends_with(".icns") {
        icon_file
    } else {
        format!("{icon_file}.icns")
    };
    let icon_path = Path::new(&app_path)
        .join("Contents/Resources")
        .join(icon_name);
    if !icon_path.exists() {
        return Ok(None);
    }

    let cache_dir = app.path().app_cache_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&cache_dir).map_err(|err| err.to_string())?;
    let file_name = format!("app-icon-{}.png", stable_name(&app_path));
    let png_path = cache_dir.join(file_name);

    let output = Command::new("/usr/bin/sips")
        .arg("-s")
        .arg("format")
        .arg("png")
        .arg(&icon_path)
        .arg("--out")
        .arg(&png_path)
        .output()
        .map_err(|err| err.to_string())?;

    if !output.status.success() {
        return Ok(None);
    }

    let bytes = fs::read(&png_path).map_err(|err| err.to_string())?;
    Ok(Some(IconInfo {
        data_url: format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(bytes)
        ),
    }))
}

fn stable_name(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

#[tauri::command]
fn check_profile_conflict(profile: CloneProfile) -> Result<ConflictInfo, String> {
    let profile = normalize_profile(profile)?;
    let app_path = app_path_for(&profile.install_dir, &profile.name);
    let info_plist = Path::new(&app_path).join("Contents/Info.plist");
    let target_exists = Path::new(&app_path).exists();
    Ok(ConflictInfo {
        app_path,
        target_exists,
        bundle_id_at_target: plist_value(&info_plist, "CFBundleIdentifier"),
    })
}

fn default_settings() -> AppSettings {
    AppSettings {
        install_dir: "/Applications".to_string(),
        base_name: "微信".to_string(),
        base_bundle_id: "net.maclub.wechat".to_string(),
        source_path: DEFAULT_SOURCE.to_string(),
    }
}

fn default_install_dir() -> String {
    "/Applications".to_string()
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join(CONFIG_FILE))
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join(SETTINGS_FILE))
}

fn save_profiles_to_path(path: &Path, profiles: &[CloneProfile]) -> Result<(), String> {
    let data = serde_json::to_string_pretty(profiles).map_err(|err| err.to_string())?;
    fs::write(path, data).map_err(|err| err.to_string())
}

fn save_settings_to_path(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let data = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    fs::write(path, data).map_err(|err| err.to_string())
}

fn normalize_settings(mut settings: AppSettings) -> Result<AppSettings, String> {
    settings.install_dir = default_install_dir();
    settings.base_name = settings
        .base_name
        .trim()
        .trim_end_matches(".app")
        .trim()
        .to_string();
    settings.base_bundle_id = settings
        .base_bundle_id
        .trim()
        .trim_end_matches('.')
        .to_string();
    settings.source_path = if settings.source_path.trim().is_empty() {
        DEFAULT_SOURCE.to_string()
    } else {
        settings.source_path.trim().to_string()
    };

    if settings.base_name.is_empty() {
        return Err("基础名称不能为空".to_string());
    }
    if settings.base_name.contains('/') || settings.base_name.contains(':') {
        return Err("基础名称不能包含 / 或 :".to_string());
    }
    if !valid_bundle_id(&settings.base_bundle_id) {
        return Err("基础 Bundle ID 只能包含字母、数字、点、短横线，且至少包含一个点".to_string());
    }
    if !settings.source_path.ends_with(".app") {
        return Err("源应用路径必须指向 .app 应用包".to_string());
    }
    Ok(settings)
}

fn normalize_profiles(profiles: Vec<CloneProfile>) -> Result<Vec<CloneProfile>, String> {
    let mut normalized = Vec::with_capacity(profiles.len());
    for profile in profiles {
        normalized.push(normalize_profile(profile)?);
    }
    Ok(normalized)
}

fn normalize_profile(mut profile: CloneProfile) -> Result<CloneProfile, String> {
    profile.name = profile
        .name
        .trim()
        .trim_end_matches(".app")
        .trim()
        .to_string();
    profile.bundle_id = profile.bundle_id.trim().to_string();
    profile.install_dir = default_install_dir();
    profile.source_path = if profile.source_path.trim().is_empty() {
        DEFAULT_SOURCE.to_string()
    } else {
        profile.source_path.trim().to_string()
    };
    profile.id = if profile.id.trim().is_empty() {
        format!("clone-{}", timestamp_millis())
    } else {
        profile.id.trim().to_string()
    };

    if profile.name.is_empty() {
        return Err("应用名称不能为空".to_string());
    }
    if profile.name.contains('/') || profile.name.contains(':') {
        return Err("应用名称不能包含 / 或 :".to_string());
    }
    if !valid_bundle_id(&profile.bundle_id) {
        return Err("Bundle ID 只能包含字母、数字、点、短横线，且至少包含一个点".to_string());
    }
    if !profile.source_path.ends_with(".app") {
        return Err("微信源路径必须指向 .app 应用包".to_string());
    }
    Ok(profile)
}

fn valid_bundle_id(value: &str) -> bool {
    value.contains('.')
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-')
        && !value.starts_with('.')
        && !value.ends_with('.')
        && !value.contains("..")
}

fn version_greater_than(left: &str, right: &str) -> bool {
    let left_parts = version_parts(left);
    let right_parts = version_parts(right);
    for index in 0..left_parts.len().max(right_parts.len()) {
        let left_value = *left_parts.get(index).unwrap_or(&0);
        let right_value = *right_parts.get(index).unwrap_or(&0);
        if left_value != right_value {
            return left_value > right_value;
        }
    }
    false
}

fn version_parts(value: &str) -> Vec<u64> {
    value
        .split(['.', '-'])
        .map(|part| {
            part.chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

fn app_path_for(install_dir: &str, name: &str) -> String {
    format!("{install_dir}/{name}.app")
}

fn plist_value(info_plist: &Path, key: &str) -> Option<String> {
    if !info_plist.exists() {
        return None;
    }
    let output = Command::new("/usr/libexec/PlistBuddy")
        .arg("-c")
        .arg(format!("Print :{key}"))
        .arg(info_plist)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn run_admin_script(script: &str) -> Result<String, String> {
    let script_path = std::env::temp_dir().join(format!("wxclone-{}.sh", timestamp_millis()));
    fs::write(&script_path, script).map_err(|err| err.to_string())?;

    let log_path = std::env::temp_dir().join(format!("wxclone-{}.log", timestamp_millis()));
    let shell_command = format!(
        "LOG={log}; /bin/sh {script} > \"$LOG\" 2>&1; CODE=$?; echo __WXCLONE_EXIT__:$CODE; cat \"$LOG\"; rm -f \"$LOG\"",
        log = shell_quote(&log_path.to_string_lossy()),
        script = shell_quote(&script_path.to_string_lossy())
    );
    let apple_script = format!(
        "do shell script {} with administrator privileges",
        applescript_string(&shell_command)
    );

    let output = Command::new("osascript")
        .current_dir("/")
        .arg("-e")
        .arg(apple_script)
        .output()
        .map_err(|err| err.to_string());

    let _ = fs::remove_file(&script_path);

    let output = output?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        eprintln!("{stdout}");
        append_persistent_log("admin-script stdout", &stdout);
        parse_admin_output(&stdout)
    } else {
        let err = command_error(output.stderr);
        append_persistent_log("admin-script osascript error", &err);
        if err.contains("-128") {
            Err("已取消管理员授权".to_string())
        } else {
            Err(err)
        }
    }
}

fn persistent_log_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "无法读取 HOME 环境变量".to_string())?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Logs")
        .join(LOG_DIR_NAME)
        .join(LOG_FILE_NAME))
}

fn append_persistent_log(label: &str, content: &str) {
    let Ok(path) = persistent_log_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let _ = writeln!(file, "\n=== {label} @ {} ===", timestamp_millis());
    let _ = writeln!(file, "{content}");
}

fn parse_admin_output(output: &str) -> Result<String, String> {
    let marker = "__WXCLONE_EXIT__:";
    let normalized = output.replace("\r\n", "\n").replace('\r', "\n");
    let Some(marker_index) = normalized.find(marker) else {
        return Ok(normalized);
    };
    let rest = &normalized[marker_index + marker.len()..];
    let mut parts = rest.splitn(2, '\n');
    let code = parts.next().unwrap_or_default().trim();
    let log = parts.next().unwrap_or_default().trim().to_string();
    if code == "0" {
        Ok(log)
    } else if log.is_empty() {
        Err(format!("管理员脚本失败，退出码 {code}，但没有输出日志"))
    } else {
        Err(format!("管理员脚本失败，退出码 {code}\n{log}"))
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn applescript_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn command_error(stderr: Vec<u8>) -> String {
    let message = String::from_utf8_lossy(&stderr).trim().to_string();
    if message.is_empty() {
        "命令执行失败".to_string()
    } else {
        message
    }
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_environment,
            load_settings,
            save_settings,
            load_profiles,
            save_profiles,
            sync_profile,
            sync_all,
            launch_profile,
            remove_profile_app,
            choose_source_app,
            reveal_profile_app,
            get_app_icon,
            check_profile_conflict,
            get_app_version,
            check_for_update,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running wxclone");
}
