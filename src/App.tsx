import { useEffect, useMemo, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  FolderOpen,
  FolderSync,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Trash2,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

type CloneProfile = {
  id: string
  name: string
  bundle_id: string
  source_path: string
  install_dir: string
  enabled: boolean
}

type AppSettings = {
  install_dir: string
  base_name: string
  base_bundle_id: string
  source_path: string
}

type EnvironmentInfo = {
  source_path: string
  source_exists: boolean
  source_bundle_id?: string | null
  source_version?: string | null
}

type OperationResult = {
  app_path: string
  message: string
}

type ConflictInfo = {
  app_path: string
  target_exists: boolean
  bundle_id_at_target?: string | null
}

type IconInfo = {
  data_url: string
}

type ToastState = {
  id: number
  title: string
  description?: string
  variant?: "default" | "destructive"
}

type BusyState = {
  action: string
  id?: string
}

const SOURCE_HINT = "/Applications/WeChat.app"
const INSTALL_HINT = "/Applications"
const MOCK_PROFILE_KEY = "wxclone.mock.profiles.v2"
const MOCK_SETTINGS_KEY = "wxclone.mock.settings.v2"

const DEFAULT_SETTINGS: AppSettings = {
  install_dir: INSTALL_HINT,
  base_name: "微信",
  base_bundle_id: "net.maclub.wechat",
  source_path: SOURCE_HINT,
}

function cleanAppName(name: string) {
  return name.trim().replace(/\.app$/i, "")
}

function cleanDir(path: string) {
  return path.trim().replace(/\/+$/g, "") || INSTALL_HINT
}

function appPathFor(profile: Pick<CloneProfile, "name" | "install_dir">) {
  return `${INSTALL_HINT}/${cleanAppName(profile.name)}.app`
}

function defaultProfiles(settings = DEFAULT_SETTINGS): CloneProfile[] {
  return [1, 2].map((index) => ({
    id: `clone-${index}`,
    name: `${settings.base_name}${index}`,
    bundle_id: `${settings.base_bundle_id}.clone${index}`,
    source_path: settings.source_path,
    install_dir: INSTALL_HINT,
    enabled: true,
  }))
}

function nextIndex(profiles: CloneProfile[]) {
  return profiles.length + 1
}

function draftFromSettings(settings: AppSettings, profiles: CloneProfile[]): CloneProfile {
  const index = nextIndex(profiles)
  return {
    id: `clone-${Date.now().toString(36)}`,
    name: `${settings.base_name}${index}`,
    bundle_id: `${settings.base_bundle_id}.clone${index}`,
    source_path: settings.source_path,
    install_dir: INSTALL_HINT,
    enabled: true,
  }
}

async function callCommand<T>(command: string, args?: Record<string, unknown>) {
  const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__)
  if (isTauri) {
    return invoke<T>(command, args)
  }

  if (command === "load_settings") {
    const raw = window.localStorage.getItem(MOCK_SETTINGS_KEY)
    return { ...(raw ? JSON.parse(raw) : DEFAULT_SETTINGS), install_dir: INSTALL_HINT } as T
  }

  if (command === "save_settings") {
    const settings = args?.settings as AppSettings
    const fixedSettings = { ...settings, install_dir: INSTALL_HINT }
    window.localStorage.setItem(MOCK_SETTINGS_KEY, JSON.stringify(fixedSettings))
    return fixedSettings as T
  }

  if (command === "get_environment") {
    const sourcePath = (args?.sourcePath as string | undefined) ?? SOURCE_HINT
    return {
      source_path: sourcePath,
      source_exists: false,
      source_bundle_id: "com.tencent.xinWeChat",
      source_version: "浏览器预览",
    } as T
  }

  if (command === "load_profiles") {
    const raw = window.localStorage.getItem(MOCK_PROFILE_KEY)
    return (raw ? JSON.parse(raw) : defaultProfiles()) as T
  }

  if (command === "save_profiles") {
    const profiles = (args?.profiles ?? []) as CloneProfile[]
    window.localStorage.setItem(MOCK_PROFILE_KEY, JSON.stringify(profiles))
    return profiles as T
  }

  if (command === "check_profile_conflict") {
    const profile = args?.profile as CloneProfile
    return {
      app_path: appPathFor(profile),
      target_exists: false,
      bundle_id_at_target: null,
    } as T
  }

  if (command === "choose_source_app") {
    return null as T
  }

  if (command === "get_app_icon") {
    return null as T
  }

  if (command === "sync_profile") {
    const profile = args?.profile as CloneProfile
    return {
      app_path: appPathFor(profile),
      message: "浏览器预览模式未执行系统命令",
    } as T
  }

  if (command === "sync_all") {
    const profiles = ((args?.profiles ?? []) as CloneProfile[]).filter(
      (profile) => profile.enabled,
    )
    return profiles.map((profile) => ({
      app_path: appPathFor(profile),
      message: "浏览器预览模式未执行系统命令",
    })) as T
  }

  return undefined as T
}

export default function App() {
  const [view, setView] = useState<"home" | "settings">("home")
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [profiles, setProfiles] = useState<CloneProfile[]>([])
  const [draft, setDraft] = useState<CloneProfile | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState<BusyState | null>(null)
  const [error, setError] = useState("")
  const [createError, setCreateError] = useState("")
  const [sourceIconPath, setSourceIconPath] = useState<string | null>(null)
  const [profileIconPaths, setProfileIconPaths] = useState<Record<string, string | null>>({})
  const [toast, setToast] = useState<ToastState | null>(null)

  const enabledCount = useMemo(
    () => profiles.filter((profile) => profile.enabled).length,
    [profiles],
  )
  const isBusy = Boolean(busy)

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 2800)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    void loadIcons()
  }, [environment?.source_path, profiles.map((profile) => `${profile.id}:${appPathFor(profile)}`).join("|")])

  async function refresh() {
    setBusy({ action: "refresh" })
    setError("")
    try {
      const loadedSettings = await callCommand<AppSettings>("load_settings")
      const [env, loadedProfiles] = await Promise.all([
        callCommand<EnvironmentInfo>("get_environment", {
          sourcePath: loadedSettings.source_path,
        }),
        callCommand<CloneProfile[]>("load_profiles"),
      ])
      setSettings({ ...loadedSettings, install_dir: INSTALL_HINT })
      setEnvironment(env)
      setProfiles(loadedProfiles)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  async function loadIcons() {
    try {
      const sourcePath = environment?.source_path || settings.source_path
      const sourceIcon = await callCommand<IconInfo | null>("get_app_icon", {
        appPath: sourcePath,
      })
      setSourceIconPath(sourceIcon?.data_url ?? null)

      const entries = await Promise.all(
        profiles.map(async (profile) => {
          const icon = await callCommand<IconInfo | null>("get_app_icon", {
            appPath: appPathFor(profile),
          })
          return [profile.id, icon?.data_url ?? null] as const
        }),
      )
      setProfileIconPaths(Object.fromEntries(entries))
    } catch {
      setSourceIconPath(null)
      setProfileIconPaths({})
    }
  }

  function notify(title: string, description?: string, variant: ToastState["variant"] = "default") {
    setToast({ id: Date.now(), title, description, variant })
  }

  async function refreshEnvironment(nextSettings = settings) {
    const env = await callCommand<EnvironmentInfo>("get_environment", {
      sourcePath: nextSettings.source_path,
    })
    setEnvironment(env)
  }

  function openCreateDialog() {
    setCreateError("")
    setDraft(draftFromSettings(settings, profiles))
    setCreateOpen(true)
  }

  function updateDraft(patch: Partial<CloneProfile>) {
    setDraft((current) => (current ? { ...current, ...patch } : current))
    setCreateError("")
  }

  function localConflict(profile: CloneProfile) {
    const name = cleanAppName(profile.name)
    const path = appPathFor(profile)
    const duplicateName = profiles.some(
      (item) => cleanAppName(item.name) === name || appPathFor(item) === path,
    )
    const duplicateBundle = profiles.some(
      (item) => item.bundle_id.trim() === profile.bundle_id.trim(),
    )

    if (!name) return "名称不能为空"
    if (!profile.bundle_id.includes(".")) return "Bundle ID 至少包含一个点"
    if (duplicateName) return `配置里已存在同名或同路径副本: ${path}`
    if (duplicateBundle) return `配置里已存在相同 Bundle ID: ${profile.bundle_id}`
    return ""
  }

  async function createProfile() {
    if (!draft) return
    setCreateError("")
    setError("")

    const localError = localConflict(draft)
    if (localError) {
      setCreateError(localError)
      return
    }

    setBusy({ action: "create-check" })
    try {
      const conflict = await callCommand<ConflictInfo>("check_profile_conflict", {
        profile: draft,
      })
      if (conflict.target_exists) {
        const bundle = conflict.bundle_id_at_target
          ? `，现有 Bundle ID: ${conflict.bundle_id_at_target}`
          : ""
        setCreateError(`目标位置已存在应用: ${conflict.app_path}${bundle}`)
        return
      }

      const nextProfiles = [...profiles, draft]
      const saved = await callCommand<CloneProfile[]>("save_profiles", {
        profiles: nextProfiles,
      })
      setProfiles(saved)
      try {
        const result = await callCommand<OperationResult>("sync_profile", {
          profile: draft,
        })
        notify(`已创建 ${draft.name}`, result.app_path)
      } catch (syncErr) {
        const rolledBack = saved.filter((profile) => profile.id !== draft.id)
        await callCommand<CloneProfile[]>("save_profiles", {
          profiles: rolledBack,
        })
        setProfiles(rolledBack)
        throw syncErr
      }
      setCreateOpen(false)
      setDraft(null)
    } catch (err) {
      setCreateError(String(err))
    } finally {
      setBusy(null)
    }
  }

  async function saveCurrentSettings() {
    setBusy({ action: "settings-save" })
    setError("")
    try {
      const saved = await callCommand<AppSettings>("save_settings", { settings })
      setSettings(saved)
      await refreshEnvironment(saved)
      notify("设置已保存")
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  async function saveProfiles(nextProfiles = profiles) {
    const saved = await callCommand<CloneProfile[]>("save_profiles", {
      profiles: nextProfiles,
    })
    setProfiles(saved)
    return saved
  }

  async function syncOne(profile: CloneProfile) {
    setBusy({ action: "sync", id: profile.id })
    setError("")
    try {
      const saved = await saveProfiles()
      const current = saved.find((item) => item.id === profile.id)
      if (!current) return
      const result = await callCommand<OperationResult>("sync_profile", {
        profile: current,
      })
      notify(`已同步 ${current.name}`, result.app_path)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  async function syncEnabled() {
    setBusy({ action: "sync-all" })
    setError("")
    try {
      const saved = await saveProfiles()
      const results = await callCommand<OperationResult[]>("sync_all", {
        profiles: saved,
      })
      notify("同步完成", `已同步 ${results.length} 个微信副本`)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  async function launch(profile: CloneProfile) {
    setBusy({ action: "launch", id: profile.id })
    setError("")
    try {
      await callCommand("launch_profile", { profile })
      notify("已启动", profile.name)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  async function reveal(profile: CloneProfile) {
    setBusy({ action: "reveal", id: profile.id })
    setError("")
    try {
      await callCommand("reveal_profile_app", { profile })
      notify("已输出到 Finder", appPathFor(profile))
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  async function deleteProfile(profile: CloneProfile) {
    setBusy({ action: "delete", id: profile.id })
    setError("")
    try {
      await callCommand("remove_profile_app", { profile })
      const nextProfiles = profiles.filter((item) => item.id !== profile.id)
      await saveProfiles(nextProfiles)
      notify("已删除", profile.name)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  async function chooseSourcePath(onChoose: (path: string) => void) {
    setBusy({ action: "choose-source" })
    setError("")
    try {
      const path = await callCommand<string | null>("choose_source_app")
      if (path) onChoose(path)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  function toggleEnabled(profile: CloneProfile, enabled: boolean) {
    const nextProfiles = profiles.map((item) =>
      item.id === profile.id ? { ...item, enabled } : item,
    )
    setProfiles(nextProfiles)
    void saveProfiles(nextProfiles)
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-7">
        <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-lg border bg-card">
              <Copy className="size-5" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-normal">WxClone</h1>
              <p className="text-sm text-muted-foreground">
                多开微信副本，升级后快速同步。
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={view === "home" ? "default" : "outline"}
              onClick={() => setView("home")}
            >
              主界面
            </Button>
            <Button
              variant={view === "settings" ? "default" : "outline"}
              onClick={() => setView("settings")}
            >
              <Settings data-icon="inline-start" />
              设置
            </Button>
          </div>
        </header>

        {view === "home" ? (
          <HomeView
            environment={environment}
            profiles={profiles}
            enabledCount={enabledCount}
            busy={busy}
            sourceIconPath={sourceIconPath}
            profileIconPaths={profileIconPaths}
            isBusy={isBusy}
            onRefresh={refresh}
            onCreate={openCreateDialog}
            onSyncAll={syncEnabled}
            onLaunch={launch}
            onSync={syncOne}
            onDelete={deleteProfile}
            onToggleEnabled={toggleEnabled}
          />
        ) : (
          <SettingsView
            settings={settings}
            setSettings={setSettings}
            isBusy={isBusy}
            onSave={saveCurrentSettings}
            onRefresh={refresh}
            onChooseSource={(callback) => void chooseSourcePath(callback)}
          />
        )}

        {error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>操作失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Toast toast={toast} onClose={() => setToast(null)} />
      </div>

      <CreateDialog
        open={createOpen}
        setOpen={setCreateOpen}
        draft={draft}
        updateDraft={updateDraft}
        createError={createError}
        isBusy={isBusy}
        onCreate={createProfile}
        onChooseSource={(callback) => void chooseSourcePath(callback)}
      />
    </main>
  )
}

function HomeView({
  environment,
  profiles,
  enabledCount,
  busy,
  sourceIconPath,
  profileIconPaths,
  isBusy,
  onRefresh,
  onCreate,
  onSyncAll,
  onLaunch,
  onSync,
  onDelete,
  onToggleEnabled,
}: {
  environment: EnvironmentInfo | null
  profiles: CloneProfile[]
  enabledCount: number
  busy: BusyState | null
  sourceIconPath: string | null
  profileIconPaths: Record<string, string | null>
  isBusy: boolean
  onRefresh: () => Promise<void>
  onCreate: () => void
  onSyncAll: () => Promise<void>
  onLaunch: (profile: CloneProfile) => Promise<void>
  onSync: (profile: CloneProfile) => Promise<void>
  onDelete: (profile: CloneProfile) => Promise<void>
  onToggleEnabled: (profile: CloneProfile, enabled: boolean) => void
}) {
  return (
    <>
      <section className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <AppIcon large iconPath={sourceIconPath} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold tracking-normal">当前微信源应用</h2>
                {environment?.source_exists ? (
                  <Badge>已找到</Badge>
                ) : (
                  <Badge variant="destructive">未找到</Badge>
                )}
                {environment?.source_version ? (
                  <Badge variant="secondary">版本 {environment.source_version}</Badge>
                ) : null}
              </div>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {environment?.source_path ?? SOURCE_HINT}
              </p>
              {environment?.source_bundle_id ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {environment.source_bundle_id}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void onRefresh()} disabled={isBusy}>
              <RefreshCw data-icon="inline-start" />
              刷新
            </Button>
            <Button variant="outline" onClick={onCreate} disabled={isBusy}>
              <Plus data-icon="inline-start" />
              创建
            </Button>
            <Button onClick={() => void onSyncAll()} disabled={isBusy || enabledCount === 0}>
              {busy?.action === "sync-all" ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <FolderSync data-icon="inline-start" />
              )}
              同步全部
            </Button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold tracking-normal">副本列表</h2>
            <p className="text-sm text-muted-foreground">
              {profiles.length} 个配置，{enabledCount} 个启用
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {profiles.map((profile) => {
            const profileBusy = busy?.id === profile.id
            return (
              <div
                key={profile.id}
                className="grid gap-3 rounded-lg border bg-card p-3 shadow-sm md:grid-cols-[52px_1fr_auto] md:items-center"
              >
                <div className="justify-self-start">
                  <AppIcon iconPath={profileIconPaths[profile.id] ?? sourceIconPath} />
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <input
                      className="size-4 rounded border-input accent-current"
                      type="checkbox"
                      checked={profile.enabled}
                      onChange={(event) =>
                        onToggleEnabled(profile, event.currentTarget.checked)
                      }
                    />
                    <div className="truncate font-medium">{profile.name}</div>
                    <Badge variant="secondary" className="shrink-0">
                      {profile.enabled ? "启用" : "停用"}
                    </Badge>
                  </div>
                  <div className="mt-2 min-w-0 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                    <span className="block truncate">{appPathFor(profile)}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {profile.bundle_id}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void onLaunch(profile)}
                    disabled={isBusy}
                  >
                    {profileBusy && busy?.action === "launch" ? (
                      <Loader2 className="animate-spin" data-icon="inline-start" />
                    ) : (
                      <Play data-icon="inline-start" />
                    )}
                    启动
                  </Button>
                  <Button size="sm" onClick={() => void onSync(profile)} disabled={isBusy}>
                    {profileBusy && busy?.action === "sync" ? (
                      <Loader2 className="animate-spin" data-icon="inline-start" />
                    ) : (
                      <FolderSync data-icon="inline-start" />
                    )}
                    同步
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void onDelete(profile)}
                    disabled={isBusy}
                  >
                    {profileBusy && busy?.action === "delete" ? (
                      <Loader2 className="animate-spin" data-icon="inline-start" />
                    ) : (
                      <Trash2 data-icon="inline-start" />
                    )}
                    删除
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </>
  )
}

function SettingsView({
  settings,
  setSettings,
  isBusy,
  onSave,
  onRefresh,
  onChooseSource,
}: {
  settings: AppSettings
  setSettings: (settings: AppSettings) => void
  isBusy: boolean
  onSave: () => Promise<void>
  onRefresh: () => Promise<void>
  onChooseSource: (callback: (path: string) => void) => void
}) {
  return (
    <section className="rounded-lg border bg-card p-5 shadow-sm">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-normal">基础设置</h2>
        <p className="text-sm text-muted-foreground">
          创建弹窗会默认复用这里的值，再自动追加序号。
        </p>
      </div>

      <Separator className="my-5" />

      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label>创建位置</Label>
          <div className="flex h-10 items-center rounded-md border bg-muted px-3 text-sm text-muted-foreground">
            固定为 /Applications
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="source-path">源应用路径</Label>
          <div className="flex gap-2">
            <Input
              id="source-path"
              value={settings.source_path}
              onChange={(event) =>
                setSettings({ ...settings, source_path: event.currentTarget.value })
              }
              placeholder="/Applications/WeChat.app"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                onChooseSource((path) => setSettings({ ...settings, source_path: path }))
              }
              disabled={isBusy}
            >
              <FolderOpen data-icon="inline-start" />
              选择
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="base-name">基础名字</Label>
          <Input
            id="base-name"
            value={settings.base_name}
            onChange={(event) =>
              setSettings({ ...settings, base_name: event.currentTarget.value })
            }
            placeholder="微信"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="base-bundle">基础 Bundle ID</Label>
          <Input
            id="base-bundle"
            value={settings.base_bundle_id}
            onChange={(event) =>
              setSettings({
                ...settings,
                base_bundle_id: event.currentTarget.value,
              })
            }
            placeholder="net.maclub.wechat"
          />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => void onRefresh()} disabled={isBusy}>
          <RefreshCw data-icon="inline-start" />
          重新载入
        </Button>
        <Button onClick={() => void onSave()} disabled={isBusy}>
          <Save data-icon="inline-start" />
          保存设置
        </Button>
      </div>
    </section>
  )
}

function CreateDialog({
  open,
  setOpen,
  draft,
  updateDraft,
  createError,
  isBusy,
  onCreate,
  onChooseSource,
}: {
  open: boolean
  setOpen: (open: boolean) => void
  draft: CloneProfile | null
  updateDraft: (patch: Partial<CloneProfile>) => void
  createError: string
  isBusy: boolean
  onCreate: () => Promise<void>
  onChooseSource: (callback: (path: string) => void) => void
}) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建微信副本</DialogTitle>
          <DialogDescription>
            默认值来自设置，可以在创建前自定义修改。
          </DialogDescription>
        </DialogHeader>

        {draft ? (
          <div className="grid gap-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="create-name">名字</Label>
                <Input
                  id="create-name"
                  value={draft.name}
                  onChange={(event) => updateDraft({ name: event.currentTarget.value })}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="create-bundle">Bundle ID</Label>
                <Input
                  id="create-bundle"
                  value={draft.bundle_id}
                  onChange={(event) =>
                    updateDraft({ bundle_id: event.currentTarget.value })
                  }
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="create-source">源应用路径</Label>
              <div className="flex gap-2">
                <Input
                  id="create-source"
                  value={draft.source_path}
                  onChange={(event) => updateDraft({ source_path: event.currentTarget.value })}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onChooseSource((path) => updateDraft({ source_path: path }))}
                  disabled={isBusy}
                >
                  <FolderOpen data-icon="inline-start" />
                  选择
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label>创建位置</Label>
              <div className="flex h-10 items-center rounded-md border bg-muted px-3 text-sm text-muted-foreground">
                固定为 /Applications
              </div>
            </div>
            <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              输出路径：{appPathFor(draft)}
            </div>
          </div>
        ) : null}

        {createError ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>存在冲突</AlertTitle>
            <AlertDescription>{createError}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isBusy}>
            取消
          </Button>
          <Button onClick={() => void onCreate()} disabled={isBusy || !draft}>
            {isBusy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
            创建配置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Toast({
  toast,
  onClose,
}: {
  toast: ToastState | null
  onClose: () => void
}) {
  if (!toast) return null

  return (
    <div className="fixed bottom-6 right-6 z-50 w-[min(360px,calc(100vw-3rem))]">
      <div
        className={cn(
          "flex items-start gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-lg",
          toast.variant === "destructive" && "border-destructive/40",
        )}
      >
        <div
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground",
            toast.variant === "destructive" && "bg-destructive text-destructive-foreground",
          )}
        >
          {toast.variant === "destructive" ? (
            <AlertCircle className="size-4" />
          ) : (
            <CheckCircle2 className="size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{toast.title}</div>
          {toast.description ? (
            <div className="mt-1 truncate text-sm text-muted-foreground">
              {toast.description}
            </div>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="h-8 px-2">
          关闭
        </Button>
      </div>
    </div>
  )
}

function AppIcon({ large = false, iconPath }: { large?: boolean; iconPath?: string | null }) {
  const iconSrc = iconPath || null

  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-[10px] bg-[#16a34a] text-white shadow-sm ring-1 ring-black/10",
        large ? "size-14" : "size-11",
      )}
    >
      {iconSrc ? (
        <img
          alt=""
          src={iconSrc}
          className={cn("rounded-[10px] object-contain", large ? "size-14" : "size-11")}
        />
      ) : (
        <svg
          aria-hidden="true"
          viewBox="0 0 64 64"
          className={large ? "size-10" : "size-8"}
        >
          <path
            fill="currentColor"
            d="M27.2 18.5c-9 0-16.3 5.8-16.3 13 0 4.1 2.4 7.7 6.1 10l-1.3 5.1 5.8-2.9c1.8.5 3.7.8 5.7.8 9 0 16.3-5.8 16.3-13s-7.3-13-16.3-13Zm-5.4 10.1a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4Zm10.8 0a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4Z"
          />
          <path
            fill="currentColor"
            fillOpacity=".88"
            d="M38.4 30.5c8.1 0 14.7 5.2 14.7 11.7 0 3.6-2.1 6.9-5.4 9l1.1 4.6-5.1-2.6c-1.6.5-3.4.7-5.3.7-8.1 0-14.7-5.2-14.7-11.7s6.6-11.7 14.7-11.7Zm-4.8 8.9a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8Zm9.7 0a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8Z"
          />
        </svg>
      )}
    </div>
  )
}
