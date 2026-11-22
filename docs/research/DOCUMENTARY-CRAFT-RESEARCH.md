# Documentary Craft Research — Best-Quality Production Across Niches

**Status:** research input (NOT a spec — specs live in PRD/TAD/DATA-SCHEMA/AGENT-SPEC)
**Researched:** 2026-11-15, via six parallel web-research passes (niches · structure · color · VFX · music · retention)
**Purpose:** consolidate the best documented practices for producing top-quality documentaries in every niche — scenarios, styles, coloring, VFX, music, and retention — as the evidence base for VendoTube Studio style presets, Director/Producer guidance, the retention rubric, and M7 Visual QC.

Everything below is sourced; source lists appear per section. Where numbers exist, they are quoted with their source.

---

## 0. Executive summary — the 12 rules that came out of everything

1. **Promise early, pay off late, never break the promise.** The title/thumbnail/hook contract is the #1 retention variable; "good CTR + steep early drop = broken promise" is the classic diagnostic.
2. **Hook in the first 10–15 s, thesis by ~0:30.** 30–50% of viewers drop in the first 3 seconds on YouTube; a 10–15% settle in the first 30 s is normal and acceptable. Delete/delay title cards — one documented case of a 6-second animated intro removed lifting retention more than any title rewrite.
3. **Write but/therefore, never and-then** (Parker/Stone; Olson's ABT). Every beat raises tension or pays one off; "closing a question with nothing new open is the most reliable way to create a drop-off point."
4. **Open loops with bookkeeping.** Open a smaller loop before closing one; numbered progress markers ("that's mistake #1 of 5"); the macro loop closes near the end, then hands off to the next video.
5. **Re-hook ~every 30 s (long-form); visible change at every transition; vary the rhythm** — metronomic pattern interrupts get filtered. MrBeast resets attention every 3–4 s; LEMMiNO does the opposite (immersion, sparse narration, ~244-day cycles) and still wins — density is a choice, *earned* change is not optional.
6. **Reveal order is chosen, not chronological.** "Chronological is rarely the best" for investigative docs; place reveals where attention drifts, not where events happened.
7. **Niche sets the look, and the look must be one system per film.** True crime = cool, desaturated, "sharp yet soft" (never murky). Nature = maximum vibrancy to the Rec.709 edge. History = warm, sepia-lean, lifted blacks + grain. Tech/business = neutral, clean, bright. Vox-style = desaturated editorial base + ONE bold accent. Fern = dark, moody 3D + heavy grade. The palette shift itself signals act turns (cool/desat on tragedy beats, amber lift on nostalgia).
8. **Archival is treated, not dumped.** Ken Burns moves at ~1–2%/sec over 4–8 s holds with easing, each move improving the story; 2.5D parallax when a photo matters; unify black point/contrast first, add grain/vignette/warmth on the archival layer only; verify frame-rate provenance before conforming.
9. **Motion graphics feel premium through restraint:** one anchor motif per video, don't over-polish ("over-polishing makes editorial work look like an ad" — Vox's art director), graphics that keep photos never static (cycling textures), tracking transitions with blur spiking on the cut.
10. **Sound is half the "quality" signal, and the #1 amateur marker.** Mix to −14 LUFS / −1 dBTP for YouTube; duck music 8–15 dB under VO with sidechain "breathing"; layer room tone → spot SFX → UI sounds → transitions → sub-impacts → score. Silence is a scoring choice: the Jinx finale's power is that nothing was added.
11. **B-roll is evidence, not wallpaper.** "Say cow, see cow" — never narrate what's on screen; stats go on text cards; verification process shots (receipts, paper trails, geolocation) ARE the credibility of investigative work.
12. **End before you're finished.** The last 60–90 s dive happens when viewers detect summary ("So overall…") or a music swell. Deliver the final payoff → transition to the next-video hook in under 10 s.

---

## 1. Niche-by-niche playbook

| Niche | Narrative spine | Visual language | Tone/voice | Exemplars | Amateur failure |
|---|---|---|---|---|---|
| True crime | Cold open in medias res (crime/aftermath) → dual timelines (buildup × present investigation); courtroom arc as spine; cliffhangers at episode ends | Crime-scene photos, interrogation footage, 911 audio; restrained reenactments (*The Imposter* as the ethical case study) | Detective/journalist/family POV; deliberate ambiguity fuels theory-crafting | *The Jinx*, *Making a Murderer*, *O.J.: Made in America*, JCS Criminal Psychology | Sensationalism without sourcing; cheap-looking reenactments |
| Nature/wildlife | Animals as named characters with goals/obstacles/arcs (hunter vs hunted, parent vs season); making-of diary ending | Long-lens intimacy, camera traps, aerial wides vs extreme close-ups; most animal audio is fabricated library/post sound | Voice-of-God wonder narration (Attenborough model), lush score | *Planet Earth*/*Blue Planet* (tech-led spectacle + patience) | Beautiful footage with no character or arc; mismatched-lighting cuts |
| History | "Why did it fall?" retrospective with hindsight; chronological spine punctuated by thesis; myth-busting framing | Archival stills w/ Ken Burns moves; animated campaign maps (Kings and Generals runs ~2,200 videos on map clarity); costumed character work as auteur variant | Measured, literary narration | Fall of Civilizations (Sumerians ep ≈41M views), Kings and Generals, Dan Carlin, Atun-Shei | Wikipedia-level scripting over stock images; no maps; no historiographical debate |
| Science/tech | Curiosity gap: counterintuitive premise → dramatize the wrong intuition → resolve. Veritasium formula: misconception → failed prediction → expert resolution → conceptual payoff | Demonstrations, experiments, clean explainer graphics | Curious first person, intellectual humility | Veritasium, SmarterEveryDay, Real Engineering, Kurzgesagt | Lecture mode — no misconception staged, so no tension |
| Social/investigative | Question-driven ("How did X get away with it?"), evidence accumulated stepwise to a verdict; OSINT paper trails as engine | Satellite imagery, geolocation, records graphics — process shots are the credibility | Sober procedural distance; filmmaker as verifier, not polemicist (Bellingcat bar) | fern (~5.7M subs, weekly), LEMMiNO, FRONTLINE, DW Documentary, Johnny Harris | Unsourced claims; omitting the verification process |
| Business/finance | Rise-and-fall corporate arcs; "how X actually makes money" unit-economics reveals; numbers spoken as narrative beats | Chart animations, logos as iconography, archival ads, kinetic type; faceless VO format | Confident storyteller, moral undertone on scandals | MagnatesMedia ("mini movies about business & money", ~1.86M subs), Modern MBA (proprietary numbers), Company Man | Press-release facts, no original figures, chart spam without interpretation |
| Sports | The game is never the subject — culture, identity, aftermath are; hindsight distance creates meaning | Broadcast archival cut against intimate present-day interviews; slow-mo recontextualization | Elegiac or mythic; rival voices in tension | *O.J.: Made in America*, *The U*, *The Last Dance*, 30 for 30 ("a story not fully explored") | Highlight-reel montage with no cultural thesis |
| Biography | Three-act life arc (inciting incident, midpoint reversal, climax); chronological vs thematic chosen in the edit; compression is the core skill ("60 years into 94 minutes") | Talking heads + photos + archival + clips | Empathetic intimacy; rise/fall/redemption cadence | *RBG*, *Amy*, CNN Films | Wikipedia chronology without a thesis about what the life means |
| Travel/culture | Character-and-challenge, never location: quest with stakes, stranger becomes co-protagonist, dilemma → action → resolution | Long takes, sensory detail, intentional coverage | First-person participatory; openness, gratitude | Yes Theory ("seek discomfort"), Eva zu Beck, Tom Allen's mini-story method | Place-lapse tourism montage — scenery without human stake |
| YouTube video-essay | Personal-quest question → animated-map journey → escalating revelation → thesis; every narration beat has a visual | Tilting/pinned maps, kinetic type, unified type/color system | First person, "I went and found out" authority | Johnny Harris, Vox, fern, LEMMiNO, David Hoffman, Matt Orchard | Stock-footage wallpaper; narration-only exposition; uncut 40-min runtimes |

**2025–26 demand economics:** finance/education is the top-paying tier (personal-finance CPM ≈ $18–45; education/science highest median RPM ≈ $10.22); mid-rolls on 8+ minute videos make long-form docs monetize watch-time better than Shorts; strongest demand: business case-study docs, true crime, history deep-dives, OSINT investigations — evergreen, faceless-friendly, bingeable.

**Cross-niche rules:** Nichols' six modes are the shared grammar (most hit YouTube docs = expository + participatory touches); the #1 amateur markers are audio quality and B-roll-as-wallpaper; open in medias res with a curiosity gap; one visual system per film; verify on screen.

**Sources (niches):** Iron Phoenix Films crime storytelling; ResearchGate "Stylistic choices in true-crime documentaries"; Taylor & Francis *The Imposter* case study; Filmmaker Magazine true-crime editing; PBS Nature behind-the-scenes; UQ Pressbooks curiosity gap; Wikipedia 30 for 30; COLLINS ESPN case study; Fall of Civilizations / Kings and Generals / Atun-Shei / fern / MagnatesMedia / Modern MBA / Yes Theory channels; New Doc Editing biographical structure; World Nomads narrative structure; RTS "10 YouTube channels for documentary fans" (Oct 2025); BecomeViral RPM by niche; Uppbeat most profitable niches; SlideShare Nichols' 6 modes; Raindance 5 big mistakes; Short of the Week. (URLs in the research session logs; representative links embedded above in the agent digests.)

---

## 2. Structure & scenario design

### 2.1 Frameworks and when each works
- **Three-act, 25/50/25** (setup/confrontation/resolution) with six plot points: opening hook, inciting incident, first-act break, midpoint setback ("forces the protagonist to rethink"), second-act break ("do or die"), climax + resolution. Endings may open new questions rather than resolve them. (Doc Film Academy)
- **Story circle (Harmon)** — You/Need/Go/Search/Find/Take/Return/Change; best used as a *pacing diagnostic*: "if you're halfway through and still in the comfort zone, something is wrong." (Reedsy, StudioBinder)
- **Freytag** — order matters, timing of climax is flexible. (Videomaker)
- **Nichols' modes as the decision key:** thesis-driven essay = expository (Vox-style); character vérité = observational (*Free Solo* — goal-driven three-act); investigative reveal = evidence-driven with deliberately chosen reveal order — **"chronological is rarely the best"** (Fixora).

### 2.2 The cold open (first 60 seconds)
- YouTube bar: **hook in 10–15 s** (30–50% drop within 3 s); a cold open that fails within 15–60 s loses half the audience.
- **Making a Murderer:** archival home video + the universalizing line "You may never commit a crime, but that doesn't mean you won't be accused" — provocation, not plot spoiler.
- **The Jinx:** opens over the actual 2003 acquittal footage (past verdict → present consequence); the bombshell ("BEVERLEY" handwriting) deliberately planted mid-season, not spoiled.
- **Free Solo:** circular open (begins and ends on the wall); test screenings forced a restructured Act One that states the goal — viewers must know the protagonist's intention early.
- **Johnny Harris / YouTube docs:** front-load "visual anchors" (images that prove the story without explanation) in the first 30–60 s and make an explicit promise about what the video will deliver.

### 2.3 Mid-story mechanics
- Escalation ladder through Act Two (50% of runtime) to a midpoint reversal, then an irreversible decision.
- **Red herrings:** a visible plotline whose beats secretly lay the foundation of the hidden plotline (*The Jinx* withheld the handwriting evidence for weeks of runtime).
- **Promise & progress:** central question planted in minute one, answer held to near the end; open a smaller loop *before* closing one; numbered progress markers; re-hooks ~every 30 s; place reveals where attention drifts.
- *Free Solo* craft: subplot (romance) as a competing pressure engine; concentrate on the 5–6 most critical story pitches; color-coded index cards for structure.

### 2.4 Endings
Failures: codas that don't ring true (subjects rejecting them — CMS Impact), endings that merely tie loose ends, unearned twists.
Working techniques: "inevitable but not predictable"; Michael Arndt's rule (great endings change how the audience sees the world, not just the plot); end on the thematic peak (*Man on Wire*); ethical-ambiguity/implication endings (*The Act of Killing*); callback payoff to the cold open (*Free Solo*'s circular return). When the groundwork is laid, **the climax needs no narration** (*Free Solo* finale plays wordless).

### 2.5 Runtime-specific pacing
- 90-min feature: 25/50/25; dips allowed as falling-action breath.
- ~45-min YouTube doc: **minute 18 is the critical zone** (opening question loses novelty); the middle third is the main drop zone (restatements, long uncut procedure, context dumped in one block). Fix by subtraction: "a 38-minute video people finish beats a 46-minute one they abandon." Watch the **30 seconds before** a decline, not the decline. Retention spikes mark rewatch-worthy moments. (Fixora)
- 10-min essays: hook 0:10–0:15, thesis ~0:30, re-hooks ~30 s, fast segments cut every 1.5–4 s (Async).
- LEMMiNO-style long-form (35 min) is the opposite bet: immersion over density — sparse deadpan narration, long pauses, chronological mystery build (~244-day production cycles).

### 2.6 Narration craft (Karen Everett / New Doc Editing + creator practice)
Conversational with contractions; no long participial openers; short sentences with PAUSE markers; **stats on text cards**; active voice; **"say cow, see cow"** — never narrate what's on screen; title-first before names; Jon Else's "NTK?" (need-to-know) test for every line; narration doubles as the transition tool. Present tense = immediacy; past = hindsight/foreshadowing. Johnny Harris writes **visual-first**: narration supports what's on screen, alternating visual anchors with facts/context. Talking heads: pick soundbites watching eyes with sound off (emotion beats over info beats); avoid yes/no questions; sequence questions so characters state the theme in their own words; keep bites short; cover every cut with claim-proving b-roll while VO runs continuously. If a subject can't articulate the theme, dramatize it visually.

**Sources (structure):** Doc Film Academy three-act guide; Reedsy + StudioBinder story circle; Videomaker Freytag; Wikipedia documentary mode + cold open; WGF Foundation + Final Draft cold-open norms; Netflix Making a Murderer; The Marshall Project "Five Lessons from The Jinx"; digitalfilms *Free Solo* editor interview (Bob Eisenhardt); Medium red-herring technique; Fixora long-form retention; Creator Essentials open loops; Video Creators ep. 382; CMS Impact "Honest Truths"; New Doc Editing "Ten Tips for Writing Documentary Narration"; Medium + How I Write podcast (Johnny Harris); The Long Story (ex-Vox journalists); Async video-essay scripting; Videomaker b-roll guides; r/LEMMiNO.

---

## 3. Color & grading

### 3.1 Per-genre look table (synthesis of colorist guidance)

| Genre | Base | Shadows | Saturation | Skin / notes |
|---|---|---|---|---|
| True crime | cool, moody, low-mid contrast; "sharp yet soft — never high-contrast or murky" | blue-navy/teal lean | −15–25% global | natural, slightly cooled; desaturated greens for "grimy/corrupt" atmospheres; red used sparingly as punctuation |
| Nature | high contrast, HDR-capable, vibrant | clean blacks | pushed to the Rec.709 edge | BBC Planet Earth II UHD/HDR grade is the benchmark |
| History/archival | warm sepia-lean, soft contrast | lifted/faded | warm bias | patina looks: grain, vignette, light leaks — as shot-specific nodes, not global |
| Tech/business | 4000–5000K neutral, clean, bright ("clean and honest") | neutral | near-neutral | HSL-qualified skin, zero cast; 5500–6500K cool only for tech/sci-fi aesthetics |
| Social-issue | naturalistic; cool/desat pressure on testimony/hard beats | gentle cool | restrained | protect skin first |
| Vox-style explainer | desaturated editorial base (cream, navy, gray) | — | restrained + ONE bold accent (yellow) for focal points | typography never changes mid-video; palette barely shifts across 15 min — that consistency reads as "journalism" |
| Fern-style cinematic 3D | dark, moody, atmospheric 3D (Blender, low-poly, heavy bloom) | deep | heavy cinematic grade | so imitable it spawned a template genre of lookalike channels |

### 3.2 Color psychology as act structure
Warm/golden + soft contrast = nostalgia/memory; draining saturation + cooling hue + flattening contrast = tragedy/dread. **Time the palette shift to the act break** — for docs: desaturate/cool by ~10–20% at a death or reveal beat; amber lift + lifted blacks for reminiscence. (StudioBinder psychology framework + film examples.)

### 3.3 Archival treatment
- Ken Burns at **~1–2%/sec (5–15% scale over 4–8 s)** with ease-out → ease-in; zoom toward the narrated subject, pan along documents; the move is cheap when reflexive — each move must "improve the story itself" (Poynter). A digital zoom is "mathematically perfect," which is why it feels sterile: humanize with parallax, paper textures, or slight jitter.
- **2.5D parallax** (foreground/mid/background layering, depth maps) when a photo carries a beat (*The Kid Stays in the Picture* lineage).
- **Frame-rate provenance:** silent-era/16mm was shot variable 16–24 fps; conforming wrong duplicates frames and drifts sync (~1 s per 20 min on a 23.976→24 error). Verify transfer speed against reel length before conforming.
- **Match archival to modern:** unify contrast curve and black point first; then period texture (grain, vignette, faded blacks, leaks) on the archival layer only.
- Editorial rule: archival carries the **emotional theme**, not literal illustration.

### 3.4 Workflow
Balance node first (normalize mixed sources), then secondaries (HSL skin qualifier, windows), then one shared look node across groups (interviews + b-roll inherit one look). Neutralize every clip to the same black point/white balance before any look; match to a neutral reference in frame. **Teal-orange in docs: cap it** — teal only into shadows/backgrounds, skin natural; docs use a fraction of Hollywood strength (consensus: the full look is cliché, but modest teal separation is legitimate since skin sits in the orange family). Base LUT + manual grade, never a LUT alone.

### 3.5 Motion-graphics color & text legibility
- Kurzgesagt: high-saturation flat vector + gradients/glows for depth; brightness deliberately counterbalances dark subject matter.
- Vox: cream/navy/gray base + yellow accent, highlighter marks, newspaper textures, kinetic type.
- Over footage, target **6–7:1 contrast plus a scrim** (plate/shadow/outline) behind captions (WCAG floor: 4.5:1 normal text, 3:1 large); sans-serif, ≤3 lines.

### 3.6 Technical standards (YouTube)
- SDR: master **Rec.709 / Gamma 2.4** (YouTube's SDR downconversion target). HDR: Rec.2020 PQ/HLG, 10-bit min, ST.2086 metadata w/ MaxCLL/MaxFALL; never tag P3 as Rec.2020 ("oversaturated, shifted hues"); UHD widths (3840).
- **Banding:** 8-bit dark gradients band badly after VP9/AV1 transcode → keep 10-bit end-to-end, upload high bitrate (4K HDR ≈ 44–56 Mbps; 4K SDR ≈ 35–50 Mbps), add light dither/grain over gradients, never crush blacks to 0; denoise dark scenes (PQ shadow range + stripped noise).
- **Saturated reds** suffer worst from 4:2:0 subsampling + VP9 red-shift complaints → keep reds below vectorscope clipping (~95%), embed correct 709 tags.

**Sources (color):** YouTube HDR help; Blare Media export settings; TourBox HDR vs SDR; Adobe Community VP9 red-shift thread; Hacker News 4:2:0; Graphic Design StackExchange Kurzgesagt style; kurzgesagt.org; School of Motion "5 Breakdowns on Replicating the Vox Motion Graphic Look"; CriticaTV Vox-style guide; fern channel; Wikipedia + CineD Ken Burns origin; Timecode App film-roll runtime calculator; MediaScribe + Verbcrafts caption contrast; r/colorists teal-orange debate; Lift Gamma Gain; Imagen AI interview grading; FilmConvert; StudioBinder color psychology; r/4kbluray BBC nature HDR discussion.

---

## 4. VFX & motion graphics

### 4.1 Archival animation
- Ken Burns parameters (above, §3.3); viewers "read" a static photo in ~1 s, so hold ~5 s with slow motion to keep giving the eye something new.
- **They Shall Not Grow Old** case study: 100+ hours of 35mm scans → dirt/scratch removal → de-noise → re-timing (hand-cranked 13–18 fps → 24; 48 fps for 3D) → grade → hand colorization verified against original uniforms hung in the grading suite → lip-readers generated dialogue for voice acting. The ceiling for archival restoration.

### 4.2 Maps & geography
Johnny Harris's stack is GEOlayers 3 + After Effects; replicable conventions: territory reveals via animated masks/track mattes (the "occupation spread" look), stroke-path route drawing coupled to camera easing, Google Earth Studio 3D flyovers composited in AE, paper/vintage texture + grain as signature styling. Vox's art director: maps are "the most tedious graphics" — shifting borders require researcher fact-checking before animation.

### 4.3 Data visualization
Hans Rosling's Gapminder storytelling is the reference; **bar-chart races** interpolate each bar's value AND rank between time slices (Bostock). House styles diverge deliberately: **Vox animates graphics "on twos" (12 fps in a 24 fps timeline)** for a hand-made stutter; **Kurzgesagt animates at 60 fps** with anticipation-and-overshoot easing. Vox's data-viz signature is physical metaphor (a paper clock becoming a pie chart) + the rule that **over-polishing makes editorial work look like an ad**.

### 4.4 Captions & kinetic type
Word-pop captions (1–3 words, emphasis words in brand color) lift completion ~42% vs static overlays (short-form ad data); parameters: bold sans, shadow 30% opacity/10 px blur or solid box, center-frame, **max two motion variables per word, dramatic pops only for key stats** — over-animation causes 3-second drop-off. Narration subtitles: broadcast standard **160–180 WPM, ≤2 lines (≤37 chars/line), ≥0.3 s display per word**, white-on-black default (BBC). **Long-form docs typically use boxed narration captions and reserve kinetic type for stat callouts.**

### 4.5 Titles & lower thirds
Lower thirds: 2–3 lines, neutral sans, high contrast, inside safe areas, **never covering face/neck, on screen 3–5 s, opposite the speaker's eyeline**, re-identify recurring speakers with a shortened cut-in, no fades (Frame.io). Titles communicate the film's "entire emotional world" in under two minutes; restrained, genre-aligned typography (Art of the Title archive).

### 4.6 Recreations & AI imagery (2025–26 norms)
PBS: re-creations must be accurate and clearly identified (verbal or on-screen disclosure); 2023 memo mandates marking ALL AI-generated content (lower-third labels, top-of-show/closing disclaimers, online notes). **Archival Producers Alliance (Sept 2024): label AI material + log every asset (prompt, date, software version, copyright).** CBS bars AI recreations of historical events; Netflix allows gen-AI for ideation only, not final deliverables (rule forged after the *What Jennifer Did* scandal; ~300 Netflix programs used gen-AI in *process* by 2025). **EU AI Act Article 50(4)** made deepfake disclosure legally binding from Aug 2025. Audience rejection concentrates where AI is *hidden* or replaces human performance of real people.

### 4.7 Invisible VFX
De-identification: motion-tracked pixelate/blur (Boris FX Continuum "Witness Protection" is the doc/true-crime tool); pixelation = the classic look, solid boxes most legally defensible, heavy blur can leak edge silhouettes, planar trackers (Mocha) survive profile turns; best practice = AI auto-detect first pass + manual keyframe correction. Stabilization/deflicker/de-noise of archival is baseline pipeline work.

### 4.8 Premium motion grammar (the Vox/fern/LEMMiNO ceiling)
1. **12 fps graphics in a 24 fps timeline** (intentional stutter) — or the opposite, 60 fps ultra-smooth (Kurzgesagt); pick one per film.
2. **Tracking transitions:** 3D camera pullback across the cut with EasyEase, motion peaking exactly on the edit, Gaussian blur building → spiking at the cut → decaying (focus-pull feel).
3. **Jagged-mask reveals** for lower thirds; text offset a few frames behind the background.
4. **Cycling textured motion backgrounds** (2–3 texture swaps/sec) so photos never sit static.
5. **Edge-only chromatic aberration + blur** (Gaussian ~3.5, subtracted circular mask, feather 50) for a lens-physical feel.
6. fern = low-poly Blender scenes + heavy bloom; LEMMiNO = minimalist refined 3D with slow drifting pushes. One **anchor motif per video**, and don't over-polish.

**Sources (VFX):** Wikipedia + Poynter + Epidemic Sound + Adobe Ken Burns; Fstoppers 2.5D; British Cinematographer + NYT They Shall Not Grow Old; aescripts Johnny Harris map posts; Storybench (Vox art director Joey Sendaydiego); PremiumBeat Vox breakdown; TED Rosling; Observable bar-chart race; Skillshare Kurzgesagt series; Videotto Kurzgesagt guide; KreateFlo kinetic typography; BBC Subtitle Guidelines; Frame.io lower thirds; LA Film School + Art of the Title; Nieman Lab DFA/DAA AI guidelines; Boris FX Witness Protection; r/LEMMiNO dupe list.

---

## 5. Music & sound

### 5.1 Scoring conventions
*The Thin Blue Line* (Philip Glass) established score under documentary interviews; lineage: *Wild Wild Country* (minimalism "not taking sides"), *Free Solo* (propulsive suspense), *The Jinx* (dark, hypnotic). **Leitmotif doctrine:** assign a theme to a subject/idea, then *transform* it (minor, fragmented, stripped) at act turns; full statement at resolution; Kurzgesagt's composers hide leitmotif callbacks across videos as easter eggs. **Ethical rule: score may amplify emotions genuinely present in the material; manufacturing sentiment the facts contradict reads as manipulation — docs carry a truth contract.**

### 5.2 Tension architecture
The Jinx finale masterclass: the hot-mic audio was discovered ~2 years after the interview in post review; the drop lands because *nothing is added* — raw source, minimal score, everything else stripped. Contrast toolkit: withheld score reads as realism/dread (*No Country for Old Men* — 122 min, no score). **The stock riser→whoosh→impact formula is now the recognized marker of cheap editing (2025 critique consensus); prefer score dynamics, ambience builds, or silence.**

### 5.3 Licensing & channel strategies
Two licenses per commercial song (sync + master); festival-scope ≈ $1,000/song for lesser-known artists, six figures–$1M for famous period recordings; production-library tracks $10–100. Content ID claims ≠ strikes; fair use is never decided by Content ID; keep license documentation. Library tiers: **Epidemic Sound** (55k+ tracks, used by ~70% of top-300 US channels, YouTube-first), **Artlist** (cinematic, Universal License covers broadcast), **Musicbed** (premium storytelling tier), Soundstripe (budget middle). Channel exemplars: **LEMMiNO composes his own scores** ("Cipher" ≈6.2M views; releases all BGM publicly); **Kurzgesagt** uses Epic Mountain (unique score per video + full sound design/mixing/master); **fern** uses recognizable licensed music (and in Sept 2025 published an investigation of an AI-pipeline documentary studio — disclosure/authenticity is now the genre's live battleground). AI music: **97% of listeners cannot distinguish fully AI-generated music** (Deezer–Ipsos, Nov 2025), but Suno/Udio output may not be copyrightable (US Copyright Office, Jan 2025) — verdict: acceptable for beds/transitions; risky for signature themes.

### 5.4 Sound-design layer stack (motion-graphics docs)
**room tone/ambience bed → spot SFX → UI/interaction sounds → whooshes/transitions → impacts/sub-bass → score.** Record 30–60 s of room tone per location and match it under dialogue to mask cuts. Whoosh on a transition implies velocity/direction; UI sounds = subtle taps confirming actions; sync SFX to keyframes; keep sub mono; watch true peak. Epic Mountain's ceiling: an entire Kurzgesagt video scored purely from sound design, no VO.

### 5.5 VO processing (incl. AI/TTS narration)
Canonical chain: **HPF ~80 Hz → corrective EQ (tame 200–400 Hz boxiness) → de-esser 4–10 kHz → compression 2:1–3:1, attack 10–30 ms, release ~100 ms, 3–6 dB GR → optional saturation → limiter**, then normalize the mix to spec. De-esser placement: before compression prevents exaggeration; difficult voices get both. For TTS (ElevenLabs guidance): speed 0.7–1.0, conversational script with deliberate punctuation, then post-process outside the platform — light compression → EQ → de-ess → tape saturation → limiter. That chain closes the gap to broadcast-grade.

### 5.6 Loudness standards (verified)
- **YouTube: −14 LUFS integrated, true peak ≤ −1 dBTP** (normalization only turns *down* louder content).
- **Netflix: −27 LKFS ±2 LU dialog-gated, ≤ −2 dBTP** (dialog anchor is the QC metric). EBU R128 −23 LUFS; ATSC A/85 −24 LKFS.
- **Music-vs-VO: duck music 8–15 dB under speech; bed ~15–20 dB below dialogue** (Epidemic guidance: dialogue −18 to −9 dB, other elements −24 to −8 dB). Sidechain compression for ducking + manual keyframes so music "breathes" up in VO pauses — that breathing is what separates pro mixes.

### 5.7 Silence as a device
Literal silence at the climactic visual (Last Jedi Holdo ram); withheld score for realism; **silence after an emotional beat so the audience can process it — often more powerful than scoring it.** The genre exemplar: the Jinx finale — the most powerful music decision of the last decade was to play raw, un-scored audio and let the room do the scoring.

**Sources (music/sound):** Vulture + THR + NBC News + r/television (Jinx audio); Wikipedia Thin Blue Line; CineD + LA Film School silence; Boom Box Post loudness specs; ElevenLabs TTS best practices + Artlist TTS tips; r/mixingmastering de-esser; Epic Mountain; LEMMiNO Music; fern; YouTube fair use + FoxiMusic Content ID guide + Hello Thematic; Motion The Agency sound design; Pro Sound Effects glossary; In the Groove Music licensing; Deezer Newsroom + Reuters AI-music study.

---

## 6. Retention engineering (YouTube)

### 6.1 Hook (first 30 s)
Steepest drop of any video: **55%+ of viewers gone inside the first minute platform-wide; 30–50% drop in the first 3 s**; a **10–15% settle in the first 30 s is normal**; YouTube's guidance claims an effective hook keeps ~83% to 0:30. Working sequence: **cold open (visual proof or claim) → confirm the click (mirror the title/thumbnail promise) → open a curiosity gap → first payoff before any branding.**
Channel formulas: Johnny Harris (sub-1-s montage clips, viewer "committed" by ~6 s, first 60 s deepen mystery, question→report→new-question loops); LEMMiNO/fern (slow atmospheric delayed-context opens; LEMMiNO uploads as events); Coffeezilla (most outrageous claim + dollar stakes + implicit "I can prove it"); Wendover (continuous flow, story-circle logic); Huggbees (tonal subversion). Title cards: **deleting a 6-second animated intro lifted early retention more than any title rewrite** — delay/integrate the card until the hook has earned it.

### 6.2 Curve anatomy (five shapes)
1. Steep 0:00–0:30 drop = broken promise or throat-clearing.
2. Gentle flat slope = every scene raises a fresh question before resolving the prior one (the ideal).
3. **Vertical cliff** (mass exit in a 10–20 s window) = recap, tangent, or unannounced subject switch.
4. Rewatch bumps = high payoff density.
5. **Dive 60–90 s before the end** = viewers detect summary phrases ("So overall…") or a music swell.
Diagnosis rule: **watch the 10 seconds before the drop, not the drop itself.** Re-hook tools: payoff-and-re-ask; mechanical resets (B-cam jump, extreme crop, speed ramp); stakes re-introduction via countdown. Cadence: **visible change every ~30 s (long-form)**; MrBeast resets every 3–4 s; vary the rhythm — metronomic interrupts get filtered.

### 6.3 Structural devices
- **But/Therefore** (Parker/Stone, verified; Olson's ABT) — beats connect with "but"/"therefore," never "and then."
- **Open loops** (Zeigarnik): taxonomy = Teaser, Question, Incomplete Story, Cliffhanger; first loop opens in title/thumbnail; macro loop closes at the end then hands to the next video; failure modes: closing loops never opened, opening too many at once, cutting obstacles for brevity.
- MagnatesMedia structure: cold-open macro loop + three acts with mini-loops + countdown/ranking escalation to a finale.
- Chapters aid navigation on segmented videos, but continuous narrative flow (Wendover, LEMMiNO) protects watch-through; change one story variable per upload to keep tests diagnosable.

### 6.4 Benchmarks & algorithm (2025–26)
- Platform-wide average retention ≈ 23.7%. **15-min docs: 35–50% AVD good; 50%+ excellent; <25% signals hook/pacing failure.** Explainers: ~50% retained at 2 min, <35% by 5 min.
- Signals: CTR (healthy 4–10%, cold non-subscriber impressions weighted more), AVD/retention, **session contribution** ("the signal that's grown the most"), survey-based "valued watch time" (can suppress distribution even with good watch time); **first 48 hours** decide expansion beyond the test audience.
- Shorts funnel: ~$0.05/1K views vs $10–25 long-form; long-form holds ~73% of US watch time; audiences don't cross over without related-video links + explicit CTAs.
- **Broken promise = the most consistently cited #1 retention killer** ("good CTR + steep early drop = hook problem"; betrayed viewers bounce within 30 s).

### 6.5 End-of-video
The pre-end dive happens when viewers *know* it's over. Deliver final payoff → transition into the next-video hook **in under 10 s**. End screens occupy the final 20 s; consensus: they don't hurt retention when overlaid on active content — dead outros do; even 1-in-20 click-through wins on session contribution. Ending formula: **payoff → brief resolution → cliffhanger/open loop → end screen pointing to a specific next video**, with the next-video mention seeded mid-video. "A great ending should feel like the beginning of the next video."

### 6.6 Packaging
Curiosity gap = a promise the video pays off; clickbait = a promise it never does. Thumbnails: expressive face or striking real photo, **3–5 words max, don't duplicate the title, high contrast at mobile size**; the title asks the question the thumbnail's subject implies. Use YouTube Test & Compare (up to 3 variants incl. titles) judged on **watch-time share, not raw CTR** (avoids selecting clickbait). Strong retention compounds into suggested-feed placement and evergreen discovery.

### 6.7 Niche differences
True crime: highest long-watch tolerance (claims of 80–95% of episode watched; brutal early cliff survivable if the curve then flattens on sustained curiosity gaps). Narrative niches outperform generic list/explainer formats by 40–60% on retention. Explainers judged on concision, tolerate faster cutting; nature/ambient tolerates slow pacing but still needs a species/ecosystem narrative thread. Caveat: no large-scale cross-niche retention study exists — benchmark reports + creator analytics only.

**Sources (retention):** vidseeds analytics-for-storytellers; EditorDuel Johnny Harris teardown; Video Creators ep. 382; Kingfinity + YouSEO algorithm 2026; YouTube Help (key moments, end screens); Nathan Weller but/therefore; Worldbuilders open loops; livecounts MrBeast case study; r/SmallYTChannel; r/NewTubers; InVideo end screens; 1of10 clickbait/thumbnails; Taja Shorts vs long-form; TVTropes Huggbees; Fluxnote true-crime niche 2026; Viral Niche Studio retention curves; Fyre Interactive script formats.

---

## 7. Ethics & evidence (binding for VendoTube)

These align with the workspace invariants (evidence-led claims, human-gated rights approval) and the 2025–26 industry norms surfaced by the research:

1. **Label AI-generated content** — on-screen or verbal disclosure; log every asset (prompt, date, software version, copyright) (DAA guidelines; PBS 2023 memo; EU AI Act Art. 50(4) from Aug 2025).
2. **Reenactments/dramatizations: accurate and clearly identified**; avoid over-dramatization (PBS).
3. **Score amplifies, never manufactures** sentiment the facts contradict (doc truth contract).
4. **The verification process is content** — show receipts, paper trails, geolocation; omission of verification is the amateur marker of investigative work (Bellingcat bar).
5. **Rights:** archival and music rights documented per asset; Content ID claims ≠ strikes; keep license documentation (fair use is never decided by Content ID).
6. **Endings must ring true** — codas rejected by subjects are documented as both ethical and retention failures (CMS Impact).

---

## 8. Mapping to VendoTube Studio (implementation hooks)

How this research converts into the Studio's existing architecture (style presets per project, Director sets style.json with the bible, Producer renders via HyperFrames compositions, M7 Visual QC gates):

### 8.1 New style presets (style.json token sets)
| Preset id | Niche | Tokens |
|---|---|---|
| `true-crime` | true crime | cool desaturated base (−15–25% sat), navy/teal shadow lean, restrained red accent, serif pairing for evidence cards, boxed captions, grain+slight vignette ON |
| `archival-history` | history | warm sepia-lean, lifted blacks, grain/vignette ON, Ken Burns-dominant transition set, literary serif |
| `science-explainer` | science/tech | Kurzgesagt-leaning: high-saturation accents + gradients, 60 fps-smooth easing profile, kinetic stat callouts, bright clean base |
| `investigative-cinema` | OSINT/investigative | fern-leaning: dark moody base, heavy bloom, low-poly 3D accents, boxed captions, sparse kinetic type |
| `business-clean` | business/finance | neutral bright base, chart-first template set, kinetic numbers, sans-serif pairing, clean whites |
| `vox-editorial` (≈ existing `vox-explainer`) | video-essay | desaturated editorial base + single bold accent, highlighter marks, newspaper textures, 12-fps "on twos" profile |
| `kallaway` (existing) | premium brand doc | keep |

Each preset = accent color, font pairing, card style id, caption style, grain/vignette, lower-third style, transition set + new optional tokens: **shadow hue lean, saturation offset %, easing profile (12fps-on-twos vs 60fps-smooth), motion-background cycling on/off**.

### 8.2 Director guidance (bible/script generation)
- Niche-aware structure templates from §1–2 (cold-open taxonomy per niche; dual timelines for true crime; misconception-first for science; question-driven evidence ladder for investigative).
- Script rules: but/therefore chains; "say cow, see cow"; stats on text cards; NTK? per line; present-tense immediacy vs past-tense hindsight chosen per niche.
- Loop bookkeeping in workflow.json: tag each beat with the loop it opens/closes; enforce "open a smaller loop before closing one"; place the biggest reveal at the retention cliff candidates (minute ~18 for 45-min; middle third generally).
- Hook spec: cold open ≤15 s with visual anchor + promise; thesis by 0:30; no title card before the hook earns it.

### 8.3 Producer / emitter parameters
- Ken Burns defaults: 1–2%/sec, 4–8 s holds, eased; per-shot direction rule (zoom to narrated subject).
- Caption spec: boxed narration captions at 160–180 WPM, ≤2 lines/37 chars; kinetic word-pop reserved for stat callouts (≤2 motion variables/word).
- Transition grammar: tracking transition w/ blur spike on the cut; cycling textured backgrounds where photos would sit static; one anchor motif per film.
- Audio chain: VO processing chain (§5.5) as ffmpeg post steps on edge-tts output; duck music 8–15 dB under VO; master −14 LUFS / −1 dBTP.

### 8.4 M7 Visual QC detectors (gate G-V additions)
- Loudness: integrated LUFS + true peak vs −14/−1.
- Caption contrast: sample frames, compute text-vs-background contrast (target 6–7:1, floor 4.5:1).
- Title-card timing: first card not before the hook window (configurable, default ≥10 s).
- Caption line-length/speed lint from script timestamps.
- Vectorscope red-clipping check on rendered frames.
- Banding sentinel: gradient test patches in dark scenes.
- Label check: AI-generated/recreation disclosures present when asset ledger flags them.

### 8.5 Retention rubric (retention.review) additions
- Hook window, thesis placement, re-hook interval (~30 s), loop bookkeeping completeness, ending formula (payoff → <10 s next-video hook), summary-phrase detection in the last 90 s, title/thumbnail promise ↔ hook alignment statement in the bible.

---

*End of research doc. Specs should cite this file as evidence base; this file itself is not normative.*
