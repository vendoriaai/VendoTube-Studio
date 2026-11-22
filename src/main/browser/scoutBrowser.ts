import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { assertPublicHttpUrl } from '../net/guard'

/**
 * Scout's visible local browser (PRD F3). Uses the system browser via
 * Playwright channels (msedge on Windows 10/11 — no bundled download needed);
 * falls back to the bundled Chromium when present. Headed by default so the
 * user can watch Scout work (exit criterion: visible local-browser research).
 *
 * Guard note: URLs are validated (scheme + resolved IPs) before navigation;
 * DNS-rebinding TOCTOU inside Chromium is a documented M5 hardening item.
 */

export interface PageRead {
  url: string
  title: string
  text: string
  html: string | null
  links: Array<{ text: string; href: string }>
  screenshotBase64: string | null
  /** True when the page is still a verification/challenge interstitial. */
  challenge?: boolean
}

const READ_TEXT_LIMIT = 24_000
const DEEP_TEXT_LIMIT = 60_000
const HTML_LIMIT = 120_000
const LINK_LIMIT = 60

/** Interstitial/challenge pages (Cloudflare & friends). When one shows up we
 * click its verification checkbox ONCE — the same single interaction a human
 * watcher would make in this visible browser — and wait for it to clear. We
 * never solve CAPTCHAs, retry in loops, or spoof fingerprints: if the site's
 * verification refuses, Scout reports honestly and moves to another source. */
const CHALLENGE_RX =
  /just a moment|attention required|security verification|access denied|verify (you are|that you are) human|are you a robot|checking your browser|ddos protection|one more step/i

export class ScoutBrowser {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private launchError: string | null = null

  constructor(
    private readonly preferredChannel: string | null, // 'msedge' | 'chrome' | null(→bundled chromium)
    private readonly headless = false
  ) {}

  get lastLaunchError(): string | null {
    return this.launchError
  }

  async ensurePage(): Promise<Page> {
    if (this.page) return this.page
    const channels = this.preferredChannel ? [this.preferredChannel, 'msedge', 'chrome', undefined] : ['msedge', 'chrome', undefined]
    let lastErr: unknown = null
    for (const channel of channels) {
      try {
        this.browser = await chromium.launch({ channel, headless: this.headless })
        this.context = await this.browser.newContext({ viewport: { width: 1366, height: 850 } })
        this.page = await this.context.newPage()
        this.launchError = null
        return this.page
      } catch (err) {
        lastErr = err
        this.browser = null
        this.context = null
        this.page = null
      }
    }
    this.launchError = lastErr instanceof Error ? lastErr.message : String(lastErr)
    throw new Error(`No usable browser channel (tried msedge/chrome/bundled). Install Edge or run npx playwright install chromium. Last error: ${this.launchError}`)
  }

  async navigate(rawUrl: string): Promise<{ url: string; title: string; isPdf: boolean }> {
    await assertPublicHttpUrl(rawUrl)
    const page = await this.ensurePage()
    await page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(1200) // let JS shells render their content
    await this.dismissOverlays() // cookie banners, promo modals, verification checkbox
    // Edge/Chrome render PDFs in an internal viewer with no extractable DOM —
    // detect it so callers can pull the text server-side instead.
    let isPdf = false
    let title = ''
    try {
      isPdf = await page.evaluate(() => {
        const ct = (document as Document & { contentType?: string }).contentType ?? ''
        if (ct === 'application/pdf') return true
        return document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]') !== null
      })
      title = await page.title()
    } catch {
      // The internal PDF viewer page can reject evaluation — fall back to URL shape.
      isPdf = /\.pdf(\?|#|$)/i.test(page.url())
      title = decodeURIComponent(page.url().split('/').pop() ?? '').slice(0, 120)
    }
    return { url: page.url(), title, isPdf }
  }

  /** Dismiss consent banners / promo modals and clear one-shot verification
   * checkboxes. Best-effort by design: a failed dismissal must never break
   * the research flow. */
  async dismissOverlays(): Promise<void> {
    const page = await this.ensurePage()
    const clickPass = (selector: string, textRx: RegExp | null): Promise<number> =>
      page
        .evaluate(
          (args: { selector: string; textRx: string | null }) => {
            const visible = (el: Element): boolean => {
              const r = el.getBoundingClientRect()
              const st = getComputedStyle(el)
              return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.pointerEvents !== 'none'
            }
            const inOverlay = (el: Element): boolean => {
              let n: Element | null = el
              for (let depth = 0; n && depth < 6; depth++, n = n.parentElement) {
                const st = n instanceof HTMLElement ? getComputedStyle(n) : null
                if (st && (st.position === 'fixed' || st.position === 'sticky')) return true
                const id = (n.id || '').toLowerCase()
                const cls = typeof n.className === 'string' ? n.className.toLowerCase() : ''
                const role = n.getAttribute('role') || ''
                if (/consent|cookie|gdpr|banner|modal|dialog|overlay|popup|paywall|subscribe|promo/.test(`${id} ${cls} ${role}`)) return true
                if (role === 'dialog') return true
              }
              return false
            }
            const unsafe = (t: string): boolean =>
              /subscribe|sign ?in|log ?in|buy|cart|download|pay|donate|register|create account|share|install|app store/i.test(t)
            const rx = args.textRx ? new RegExp(args.textRx, 'i') : null
            let clicked = 0
            for (const el of Array.from(document.querySelectorAll(args.selector))) {
              if (!visible(el)) continue
              const text = (el.textContent || '').trim()
              if (unsafe(text) || unsafe(el.getAttribute('aria-label') || '')) continue
              if (rx && !(rx.test(text) || rx.test(el.getAttribute('aria-label') || ''))) continue
              if (!rx && !inOverlay(el)) continue
              try {
                ;(el as HTMLElement).click()
                clicked++
              } catch {
                /* ignore individual failures */
              }
            }
            return clicked
          },
          { selector, textRx: textRx ? textRx.source : null }
        )
        .catch(() => 0)

    // Pass 1: known consent-platform buttons + accept-style text in overlays.
    await clickPass(
      [
        '#onetrust-accept-btn-handler', '#onetrust-close-btn-handler', '.onetrust-close-btn-handler',
        '#CybotCookiebotDialogBodyButtonAccept', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '#qc-cmp2-ui button[mode="primary"]', '.qc-cmp2-summary-buttons button[mode="primary"]',
        '.sp_choice_type_11', '#truste-consent-button', '.fc-cta-consent', '.fc-cta-accept',
        '.cc-allow', '.cc-dismiss', '#accept-all-button', '[data-action="accept-all"]',
        '.js-accept-cookies', '.js-gdpr-accept'
      ].join(', '),
      null
    )
    await clickPass(
      'button, a[role="button"], [role="button"], a.btn, input[type="button"], input[type="submit"]',
      /^(accept( all( cookies)?)?|i agree|agree|allow all|accept & close|got it|ok,? (got it|understand)|continue( with recommended)?|reject all|deny|decline( all)?|no thanks)$/i
    )
    await page.waitForTimeout(400)

    // Pass 2: generic close affordances (X icons) — only if overlays remain.
    await clickPass(
      '[aria-label="Close" i], [aria-label="Dismiss" i], [aria-label="close" i], .modal-close, .popup-close, .close-btn, button[class*="close" i]',
      /^(close|dismiss|×|x)$/i
    )
    await clickPass('button, [role="button"], a[role="button"]', /^(close|dismiss|×|x)$/i)
    await page.waitForTimeout(300)

    // Verification checkbox (Cloudflare Turnstile & similar): one click, then wait.
    await this.clickVerificationCheckbox()
  }

  private async clickVerificationCheckbox(): Promise<void> {
    const page = await this.ensurePage()
    let onChallenge = false
    try {
      onChallenge = CHALLENGE_RX.test(await page.title())
    } catch {
      return
    }
    const cfFrame = page.frames().find((f) => /challenges\.cloudflare\.com/i.test(f.url()))
    if (!onChallenge && !cfFrame) return // nothing to clear
    if (cfFrame) {
      try {
        const box = cfFrame.locator('input[type="checkbox"], label.ctp-checkbox-label, .ctp-checkbox-label').first()
        if (await box.isVisible().catch(() => false)) {
          await box.click({ timeout: 4000, force: true })
        }
      } catch {
        /* managed mode has no clickable checkbox — the wait below handles it */
      }
    }
    // Give the verification up to 15s to clear; never retry or re-click.
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await page.waitForTimeout(600)
      let stuck: boolean
      try {
        stuck = CHALLENGE_RX.test(await page.title())
      } catch {
        return
      }
      if (!stuck) return
    }
  }

  async read(opts: { screenshot?: boolean; deep?: boolean; html?: boolean } = {}): Promise<PageRead> {
    const page = await this.ensurePage()
    await this.dismissOverlays().catch(() => undefined) // banners can appear after JS boots

    // Deep read: scroll the whole page so lazy-loaded sections render before
    // extraction (robots-blocked / JS-heavy sites rely on this path). The
    // sweep returns to wherever the viewport was — an explicit scroll position
    // must survive the read or every screenshot would be of the page top.
    if (opts.deep) {
      await page.evaluate(async () => {
        const start = document.scrollingElement?.scrollTop ?? window.scrollY
        await new Promise<void>((resolve) => {
          const step = Math.round(window.innerHeight * 0.8) || 600
          let travelled = 0
          const tick = (): void => {
            window.scrollBy(0, step)
            travelled += step
            const bottom = Math.min(document.body?.scrollHeight ?? 0, 80_000)
            if (travelled >= bottom + window.innerHeight * 2) resolve()
            else window.setTimeout(tick, 220)
          }
          tick()
        })
        window.scrollTo(0, start)
      })
      await page.waitForTimeout(700)
    }

    const textLimit = opts.deep ? DEEP_TEXT_LIMIT : READ_TEXT_LIMIT
    const data = await page.evaluate(
      (args: { html: boolean }) => {
        const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]
        let cleanedHtml: string | null = null
        if (args.html) {
          const clone = document.documentElement.cloneNode(true) as HTMLElement
          for (const el of Array.from(clone.querySelectorAll('script, style, noscript, svg, iframe, link, meta'))) {
            el.remove()
          }
          cleanedHtml = (clone.outerHTML ?? '').replace(/\s{2,}/g, ' ')
        }
        return {
          url: location.href,
          title: document.title,
          text: document.body?.innerText ?? '',
          html: cleanedHtml,
          links: anchors
            .map((a) => ({ text: (a.textContent ?? '').trim().slice(0, 90), href: a.href }))
            .filter((l) => /^https?:/i.test(l.href) && l.text.length > 0)
        }
      },
      { html: opts.html === true }
    )
    const screenshotBase64 = opts.screenshot
      ? (await page.screenshot({ type: 'jpeg', quality: 45 })).toString('base64')
      : null
    return {
      url: data.url,
      title: data.title,
      text: data.text.slice(0, textLimit),
      html: data.html ? data.html.slice(0, HTML_LIMIT) : null,
      links: dedupeLinks(data.links).slice(0, LINK_LIMIT),
      screenshotBase64,
      challenge: CHALLENGE_RX.test(data.title)
    }
  }

  async bringToFront(): Promise<void> {
    await this.ensurePage()
    await this.page?.bringToFront()
  }

  /** Move the viewport so the next read/screenshot captures a specific part
   * of the page (middle sections, footers — film material lives below the
   * fold). Waits briefly so lazy content renders at the new position. */
  async scroll(opts: { direction: 'down' | 'up' | 'top' | 'bottom'; viewports?: number } = { direction: 'down' }): Promise<{
    url: string
    title: string
    scroll_y: number
    page_height: number
    viewport_height: number
    at_top: boolean
    at_bottom: boolean
    moved: boolean
  }> {
    const page = await this.ensurePage()
    const viewports = Math.max(1, Math.min(Number(opts.viewports) || 1, 10))
    const dir = opts.direction === 'up' || opts.direction === 'top' || opts.direction === 'bottom' ? opts.direction : 'down'
    const before = await page.evaluate(() => document.scrollingElement?.scrollTop ?? window.scrollY)
    await page.evaluate(
      (args: { dir: string; viewports: number }) => {
        const vh = window.innerHeight || 850
        const el = document.scrollingElement
        if (args.dir === 'top') window.scrollTo(0, 0)
        else if (args.dir === 'bottom') window.scrollTo(0, (el?.scrollHeight ?? document.body?.scrollHeight ?? vh) - vh)
        else if (args.dir === 'up') window.scrollBy(0, -vh * args.viewports)
        else window.scrollBy(0, vh * args.viewports)
      },
      { dir, viewports }
    )
    await page.waitForTimeout(600) // let lazy content render at the new position
    const after = await page.evaluate(() => ({
      y: document.scrollingElement?.scrollTop ?? window.scrollY,
      h: document.scrollingElement?.scrollHeight ?? document.body?.scrollHeight ?? 0,
      vh: window.innerHeight || 850,
      title: document.title
    }))
    const bottomBound = Math.max(0, after.h - after.vh)
    return {
      url: page.url(),
      title: after.title,
      scroll_y: Math.round(after.y),
      page_height: Math.round(after.h),
      viewport_height: Math.round(after.vh),
      at_top: after.y <= 4,
      at_bottom: after.y >= bottomBound - 4,
      moved: Math.abs(after.y - before) > 4
    }
  }

  /** Collect meaningful images on the current page as media-candidate rows.
   * Forces lazy-loaded images to load first (most article pages defer them —
   * without this naturalWidth is 0 and every candidate gets filtered out). */
  async collectImages(minWidth = 380): Promise<Array<Record<string, unknown>>> {
    const page = await this.ensurePage()
    const pageUrl = page.url()
    const domain = new URL(pageUrl).hostname.replace(/^www\./, '')
    // scroll the page and flip lazy images to eager so they actually decode
    // (returns to the viewport position the browser had — this runs after
    // every read, so an unconditional reset-to-top would wipe an explicit
    // scroll position and make every follow-up screenshot the page top)
    await page.evaluate(async () => {
      const start = document.scrollingElement?.scrollTop ?? window.scrollY
      for (const img of Array.from(document.querySelectorAll('img'))) {
        if ((img as HTMLImageElement).loading === 'lazy') (img as HTMLImageElement).loading = 'eager'
        const lazy = (img as HTMLImageElement).getAttribute('data-src') || (img as HTMLImageElement).getAttribute('data-original')
        if (lazy && !(img as HTMLImageElement).src) (img as HTMLImageElement).src = lazy
      }
      await new Promise<void>((resolve) => {
        const step = Math.round(window.innerHeight * 0.9) || 600
        let travelled = 0
        const tick = (): void => {
          window.scrollBy(0, step)
          travelled += step
          const bottom = Math.min(document.body?.scrollHeight ?? 0, 60_000)
          if (travelled >= bottom + window.innerHeight) resolve()
          else window.setTimeout(tick, 150)
        }
        tick()
      })
      window.scrollTo(0, start)
    })
    await page.waitForTimeout(900) // let flipped images finish decoding
    const rows = await page.evaluate((minW: number) => {
      // largest srcset variant ('w' widths and 'x' densities), else null
      const largestSrcset = (img: HTMLImageElement): string | null => {
        const srcset = img.getAttribute('srcset')
        if (!srcset) return null
        let best: { url: string; w: number } | null = null
        for (const part of srcset.split(',')) {
          const [url, w] = part.trim().split(/\s+/)
          const width = w && w.endsWith('w') ? Number(w.slice(0, -1)) : w && w.endsWith('x') ? Math.round((img.naturalWidth || img.clientWidth || 0) * Number(w.slice(0, -1))) : 0
          if (!best || width > best.w) best = { url, w: width }
        }
        return best?.url ?? null
      }
      const isWikimediaThumb = (url: string): boolean => /:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/[^/]+\/thumb\//i.test(url)
      const out: Array<{ src: string; alt: string; w: number; wm: boolean }> = []
      for (const img of Array.from(document.querySelectorAll('img'))) {
        const ss = largestSrcset(img)
        const src =
          (ss && /^https?:/i.test(ss) ? ss : null) ||
          (img as HTMLImageElement).currentSrc ||
          (img as HTMLImageElement).src ||
          (img as HTMLImageElement).getAttribute('data-src') ||
          ''
        if (!/^https?:/i.test(src)) continue
        const w = img.naturalWidth || img.width || 0
        const wm = isWikimediaThumb(src)
        // Wikimedia thumbs render small but the original file is full-res —
        // accept them regardless of display width (rewritten below).
        if (w < minW && !wm) continue
        // skip obvious chrome: icons, logos, sprites
        const cls = (img.className || '').toString().toLowerCase()
        if (/logo|icon|sprite|avatar|badge/.test(cls)) continue
        out.push({ src, alt: (img.alt || '').trim().slice(0, 120), w, wm })
      }
      // dedupe by src
      const seen = new Set<string>()
      return out.filter((r) => (seen.has(r.src) ? false : (seen.add(r.src), true)))
    }, minWidth)
    return rows.map((r) => ({
      provider: 'web',
      title: r.alt || decodeURIComponent(r.src.split('/').pop() ?? 'image').slice(0, 90),
      asset_page_url: pageUrl,
      download_url: wikimediaOriginalUrl(r.src) ?? r.src,
      media_type: 'image',
      license: 'unverified (editorial review required)',
      creator: domain,
      notes: `harvested from ${domain} article page; rights unverified — human review required`
    }))
  }

  async close(): Promise<void> {
    if (this.browser) {
      // browser.close() can hang on headed Edge after overlay interactions —
      // race it with a kill fallback so runs never stall on shutdown.
      const b = this.browser
      const proc = (b as unknown as { process?: () => { kill: () => void } | null }).process?.()
      await Promise.race([
        b.close().catch(() => undefined),
        new Promise((r) =>
          setTimeout(() => {
            try {
              proc?.kill()
            } catch {
              /* already gone */
            }
            r(null)
          }, 8000)
        )
      ])
    }
    this.browser = null
    this.context = null
    this.page = null
  }
}

/** Rewrite a Wikimedia thumbnail URL to the original full-resolution file:
 * .../thumb/7/77/Name.jpg/120px-Name.jpg -> https://upload.wikimedia.org/.../7/77/Name.jpg
 * (SVG thumbs resolve to their .svg original from the pre-size segment).
 * Article pages render small thumbnails, so harvesting display-size URLs
 * would only ever fetch 120-300px images — the originals are what the film
 * actually needs. Returns null for non-Wikimedia URLs. */
export function wikimediaOriginalUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (!/(?:^|\.)wikimedia\.org$/i.test(u.hostname)) return null
    const m = u.pathname.match(/^\/wikipedia\/([^/]+)\/thumb\/(.+)$/)
    if (!m) return null
    const segs = m[2].split('/')
    if (segs.length < 4) return null
    return `https://upload.wikimedia.org/wikipedia/${m[1]}/${segs.slice(0, -1).join('/')}`
  } catch {
    return null
  }
}

function dedupeLinks(links: Array<{ text: string; href: string }>): Array<{ text: string; href: string }> {
  const seen = new Set<string>()
  const out: Array<{ text: string; href: string }> = []
  for (const l of links) {
    const key = l.href.split('#')[0]
    if (seen.has(key)) continue
    seen.add(key)
    out.push(l)
  }
  return out
}
