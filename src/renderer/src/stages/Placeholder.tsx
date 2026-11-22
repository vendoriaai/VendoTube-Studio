import { Mono } from '../components/ui'

const MILESTONES: Record<string, { m: string; line: string }> = {
  bible: { m: 'M2', line: 'The Director writes the Documentary Bible here: arc, scenes, emotional curve.' },
  assets: { m: 'M1', line: 'Scout harvests documents, images, footage, audio and data into this library.' },
  script: { m: 'M2', line: 'Evidence-mapped script and shot list appear once research is approved.' },
  preview: { m: 'M3', line: 'Draft renders play here with beat markers once the Producer exists.' },
  delivery: { m: 'M3', line: 'Final MP4, delivery ZIP and the YouTube kit land here.' }
}

export function Placeholder({ stage }: { stage: string }) {
  const info = MILESTONES[stage] ?? { m: '—', line: 'Coming soon.' }
  return (
    <div className="grid h-full place-items-center">
      <div className="max-w-sm text-center">
        <Mono className="text-[12px] text-ink-muted/70">{info.m}</Mono>
        <p className="mt-2 font-display text-[18px] font-medium capitalize">{stage}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{info.line}</p>
      </div>
    </div>
  )
}
