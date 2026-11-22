import { useEffect, useState } from 'react'
import { api, studioUrl } from '../lib/api'
import { useStudio } from '../state/store'
import { Badge, Button, Card, Field, Input, Mono, Select, Spinner } from '../components/ui'
import type { BridgePathsResult } from '@shared/ipc'

/** Settings (UI-UX-SPEC §4.8): appearance, provider, engine diagnostics. */

export function Settings() {
  const { theme, setTheme, keyStatus, setKeyStatus, setProvider, provider, appInfo, activeProject, setToast } = useStudio()
  const [keyDraft, setKeyDraft] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyMsg, setKeyMsg] = useState<string | null>(null)
  const [paths, setPaths] = useState<BridgePathsResult | null>(null)
  const [providerBase, setProviderBase] = useState('https://openrouter.ai/api/v1')
  const [providerModel, setProviderModel] = useState('openrouter/auto')
  const [scoutModel, setScoutModel] = useState('')
  const [directorModel, setDirectorModel] = useState('')
  const [visualModel, setVisualModel] = useState('')
  const [modelsDirty, setModelsDirty] = useState(false)
  const [voice, setVoice] = useState('en-US-AndrewMultilingualNeural')
  const [voices, setVoices] = useState<Array<{ shortName: string; gender: string; locale: string; name: string }>>([])
  const [previewing, setPreviewing] = useState(false)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [renderPriority, setRenderPriority] = useState<'low' | 'normal'>('low')

  useEffect(() => {
    void api.providerKeyStatus().then(setKeyStatus)
    void api.bridgePaths().then(setPaths).catch(() => setPaths(null))
    void api.settingsAll().then((s) => {
      if (typeof s['provider.base_url'] === 'string' && s['provider.base_url']) setProviderBase(s['provider.base_url'])
      if (typeof s['provider.model'] === 'string' && s['provider.model']) setProviderModel(s['provider.model'])
      if (typeof s['agent.scout_model'] === 'string') setScoutModel(s['agent.scout_model'])
      if (typeof s['agent.director_model'] === 'string') setDirectorModel(s['agent.director_model'])
      if (typeof s['agent.visual_model'] === 'string') setVisualModel(s['agent.visual_model'])
      if (typeof s['tts_voice'] === 'string' && s['tts_voice']) setVoice(s['tts_voice'])
      if (s['render.priority'] === 'normal') setRenderPriority('normal')
    })
    void api
      .ttsVoices('en')
      .then((res) => setVoices(res.voices.slice(0, 60)))
      .catch(() => setVoices([]))
  }, [setKeyStatus])

  const saveModels = async (): Promise<void> => {
    await api.setSetting('agent.scout_model', scoutModel.trim() || '')
    await api.setSetting('agent.director_model', directorModel.trim() || '')
    await api.setSetting('agent.visual_model', visualModel.trim() || '')
    setModelsDirty(false)
    setToast('Per-agent models saved')
  }

  const saveRenderPriority = (value: 'low' | 'normal'): void => {
    setRenderPriority(value)
    void api
      .setSetting('render.priority', value)
      .then(() => setToast(value === 'low' ? 'Background rendering saved' : 'Full-speed rendering saved'))
      .catch(() => setToast('Could not save render performance'))
  }

  const previewVoice = async (): Promise<void> => {
    if (!activeProject) return
    setPreviewing(true)
    try {
      await api.setSetting('tts_voice', voice)
      const res = await api.ttsPreviewVoice(activeProject.id, voice)
      setPreviewSrc(studioUrl(`${activeProject.path}/${res.wav}`.replace(/\\/g, '/')))
    } finally {
      setPreviewing(false)
    }
  }

  const saveKey = async (): Promise<void> => {
    setKeyBusy(true)
    setKeyMsg(null)
    try {
      const status = await api.setProviderKey(keyDraft.trim())
      setKeyStatus(status)
      setKeyDraft('')
      setKeyMsg(`Key saved (${status.secure ? 'DPAPI-encrypted' : 'UNENCRYPTED fallback'}).`)
    } catch (err) {
      setKeyMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setKeyBusy(false)
    }
  }

  const testKey = async (): Promise<void> => {
    setKeyBusy(true)
    try {
      const health = await api.providerHealth()
      setProvider(health)
      setKeyMsg(health.ok ? `Provider OK (${health.label ?? 'connected'})` : `Provider error: ${health.error}`)
    } finally {
      setKeyBusy(false)
    }
  }

  const removeKey = async (): Promise<void> => {
    const status = await api.deleteProviderKey()
    setKeyStatus(status)
    setProvider(null)
    setKeyMsg('Key removed.')
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-5">
        <h1 className="font-display text-[22px] font-semibold">Settings</h1>

        <Card className="p-5">
          <h2 className="mb-3 font-display text-[15px] font-semibold">Appearance</h2>
          <div className="flex gap-2">
            {(['dark', 'light', 'system'] as const).map((mode) => (
              <Button key={mode} variant={theme === mode ? 'primary' : 'subtle'} onClick={() => { setTheme(mode); void api.setTheme(mode) }}>
                {mode}
              </Button>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 font-display text-[15px] font-semibold">Model provider</h2>
          <p className="mb-4 text-[12px] text-ink-muted">
            Any OpenAI-compatible endpoint: OpenRouter (default), Z.ai, or local Ollama (<Mono>http://localhost:11434/v1</Mono> — note
            Scout refuses localhost <em>page fetches</em>, but your own LLM endpoint is always allowed). Key is stored with OS-level
            encryption (DPAPI) and never logged or exported.
          </p>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <Field label="Base URL">
              <Input
                value={providerBase}
                onChange={(e) => setProviderBase(e.target.value)}
                placeholder="https://openrouter.ai/api/v1"
              />
            </Field>
            <Field label="Model">
              <Input
                value={providerModel}
                onChange={(e) => setProviderModel(e.target.value)}
                placeholder="openrouter/auto"
              />
            </Field>
          </div>
          <div className="mb-4 flex items-center gap-2">
            <Button
              variant="subtle"
              onClick={() => {
                void api.setSetting('provider.base_url', providerBase.trim() || 'https://openrouter.ai/api/v1')
                void api.setSetting('provider.model', providerModel.trim() || 'openrouter/auto')
                setKeyMsg('Endpoint saved — new Scout runs will use it immediately.')
              }}
            >
              Save endpoint
            </Button>
            <span className="text-[11px] text-ink-muted/70">
              Z.ai: <Mono>https://api.z.ai/api/paas/v4</Mono> + model <Mono>glm-4.6</Mono> · Ollama: <Mono>http://localhost:11434/v1</Mono>
            </span>
          </div>
          {keyStatus?.configured ? (
            <div className="mb-3 flex items-center gap-2 text-[13px]">
              <Badge tone={provider?.ok ? 'ok' : 'warn'}>{provider?.ok ? 'connected' : 'key set'}</Badge>
              <Mono>•••• {keyStatus.last4}</Mono>
              <span className="text-[11px] text-ink-muted">{keyStatus.secure ? 'encrypted' : '⚠ unencrypted fallback'}</span>
            </div>
          ) : (
            <p className="mb-3 text-[12px] text-ink-muted">No key configured.</p>
          )}
          <div className="flex items-end gap-2">
            <Field label="API key">
              <Input
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="sk-or-…"
                className="w-80"
              />
            </Field>
            <Button onClick={() => void saveKey()} disabled={keyBusy || keyDraft.trim().length < 8}>
              {keyBusy ? <Spinner /> : null} Save
            </Button>
            <Button variant="subtle" onClick={() => void testKey()} disabled={keyBusy || !keyStatus?.configured}>
              Test
            </Button>
            {keyStatus?.configured ? (
              <Button variant="ghost" onClick={() => void removeKey()} disabled={keyBusy}>
                Remove
              </Button>
            ) : null}
          </div>
          {keyMsg ? <p className="mt-2 text-[12px] text-ink-muted">{keyMsg}</p> : null}
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 font-display text-[15px] font-semibold">Models per agent</h2>
          <p className="mb-3 text-[12px] leading-relaxed text-ink-muted">
            Empty = the default model above. Scout browses (fast models work well); Director designs (use your strongest); Visual QC
            reviews sampled frames (needs a vision-capable model — leave empty to disable the M7 vision pass). The Producer itself is
            a deterministic pipeline — no model.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Scout model">
              <Input value={scoutModel} onChange={(e) => { setScoutModel(e.target.value); setModelsDirty(true) }} placeholder="same as default" />
            </Field>
            <Field label="Director model">
              <Input value={directorModel} onChange={(e) => { setDirectorModel(e.target.value); setModelsDirty(true) }} placeholder="same as default" />
            </Field>
            <Field label="Visual QC model (vision)">
              <Input value={visualModel} onChange={(e) => { setVisualModel(e.target.value); setModelsDirty(true) }} placeholder="empty = vision review off" />
            </Field>
          </div>
          <div className="mt-3">
            <Button variant="subtle" onClick={() => void saveModels()} disabled={!modelsDirty}>
              {modelsDirty ? 'save models' : 'saved'}
            </Button>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 font-display text-[15px] font-semibold">Narration voice (edge-tts)</h2>
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <Field label="Default voice">
                <Select value={voice} onChange={(e) => setVoice(e.target.value)}>
                  {voices.length === 0 ? <option value="en-US-AndrewMultilingualNeural">en-US-AndrewMultilingualNeural</option> : null}
                  {voices.map((v) => (
                    <option key={v.shortName} value={v.shortName}>
                      {v.shortName} ({v.gender}, {v.locale})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button variant="subtle" onClick={() => void previewVoice()} disabled={!activeProject || previewing}>
              {previewing ? 'synthesizing…' : 'preview'}
            </Button>
          </div>
          {previewSrc ? (
            <audio className="mt-3 w-full" src={previewSrc} controls autoPlay />
          ) : (
            <p className="mt-2 text-[11px] text-ink-muted/80">
              Preview renders a short sample with this voice (needs a project open; first use is the narration gate G-D).
            </p>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 font-display text-[15px] font-semibold">Render performance</h2>
          <p className="mb-3 text-[12px] leading-relaxed text-ink-muted">
            Background (recommended) renders films at low OS priority, so your PC stays responsive while a film is rendering — renders
            just take a bit longer while you work. Full speed uses the whole machine for the fastest render, but the PC may feel
            sluggish until it finishes.
          </p>
          <Field label="Render priority">
            <Select value={renderPriority} onChange={(e) => saveRenderPriority(e.target.value === 'normal' ? 'normal' : 'low')}>
              <option value="low">Background (recommended) — PC stays responsive</option>
              <option value="normal">Full speed — fastest render, may lag the PC</option>
            </Select>
          </Field>
          <p className="mt-2 text-[11px] text-ink-muted/80">
            New renders pick up a change immediately; bridge-side steps (loudness, QC) after an app restart. Films never render two at
            once — a second one waits its turn.
          </p>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 font-display text-[15px] font-semibold">Studio Bridge &amp; engine</h2>
          {paths ? (
            <dl className="space-y-2 text-[12.5px]">
              <Path label="python" value={paths.python} />
              <Path label="dwk_root" value={paths.dwkRoot} />
              <Path label="ffmpeg" value={paths.ffmpeg ?? 'not found'} />
              <Path label="ffprobe" value={paths.ffprobe ?? 'not found'} />
            </dl>
          ) : (
            <p className="text-[12px] text-ink-muted">Bridge not reachable — run `npm run setup:bridge` and restart.</p>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 font-display text-[15px] font-semibold">Data & privacy</h2>
          <dl className="space-y-2 text-[12.5px]">
            <Path label="app data" value={appInfo?.appDataDir ?? '—'} />
            <Path label="projects root" value={appInfo?.projectsRoot ?? '—'} />
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-muted/80">
            No telemetry, ever. Projects, journals, and renders stay on your disk. API keys are DPAPI-encrypted via Electron
            safeStorage. Narration uses Microsoft Edge voices (edge-tts, an unofficial endpoint) — text sent for synthesis is
            covered by the Microsoft Online Services Terms; the offline SAPI fallback avoids the network entirely.
          </p>
        </Card>
      </div>
    </div>
  )
}

function Path({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-28 shrink-0 text-ink-muted">{label}</dt>
      <dd className="min-w-0">
        <Mono className="block truncate" >
          <span title={value}>{value}</span>
        </Mono>
      </dd>
    </div>
  )
}
