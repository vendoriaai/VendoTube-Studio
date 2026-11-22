import { EVENTS } from '@shared/ipc'

/**
 * Media handles the renderer holds open (2026-11-19).
 *
 * A `<video>` streaming through `studio://` keeps the file locked for as long
 * as the element lives; on Windows that makes deleting the project fail with
 * EBUSY. Before a delete, main asks the renderer to release (`projects:release`),
 * the renderer detaches every registered element and acknowledges, and only
 * then does main unlink the folder.
 */

const held = new Set<HTMLMediaElement>()
let listening = false

/** Register a media element so a delete request can detach it. */
export function holdMedia(el: HTMLMediaElement): () => void {
  held.add(el)
  return () => {
    held.delete(el)
  }
}

/** Detach an element from its source, closing the stream and decoder. */
export function releaseMedia(el: HTMLMediaElement): void {
  try {
    el.pause()
    el.removeAttribute('src')
    el.load()
  } catch {
    /* element already torn down */
  }
}

/** Release every registered element. */
export function releaseAllMedia(): void {
  for (const el of held) releaseMedia(el)
  held.clear()
}

/**
 * Answer main's release request for a project delete. Called once at startup;
 * the handler is idempotent so a second call is harmless.
 */
export function listenForReleaseRequests(): void {
  if (listening) return
  listening = true
  window.api.on(EVENTS.ProjectsRelease, () => {
    releaseAllMedia()
    window.api.send(EVENTS.ProjectsReleased)
  })
}