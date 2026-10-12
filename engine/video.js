/**
 * AE1 - video.
 *
 * `AE1Video` is a built-in base: `(extends Video)`. It draws a video into its own
 * bounds via the `draw()` hook -- the same hook Text uses and an author has.
 *
 * A <video> element drawn with drawImage, not a DOM overlay. An overlay would sit
 * outside the canvas, ignore the letterbox transform, and be impossible to layer
 * elements over. drawImage puts video in the scene, where a prompt can sit on top
 * of it and the camera applies to both.
 *
 * (drawImage from a file:// video taints the canvas. That costs nothing: the
 * engine never reads pixels back.)
 */

import { AE1Element, defineDatAccessors } from './element.js';
import { onFirstGesture, hasGestured } from './gesture.js';

/**
 * Decoded videos are expensive -- each holds a decoder, not just pixels -- so the
 * cache is small. A point-and-click has one playing at a time; a menu with a
 * looping background plus an intro is two.
 */
const MAX_VIDEOS = 4;

// Names here are prefixed because the export CONCATENATES every engine module
// into one scope (DESIGN.md §8.2). `cache`, `keyOf`, and `evict` all already
// exist in media.js; the bundler refused the build rather than let them shadow —
// which would have silently broken image caching in every shipped game.
const videoCache = new Map();

const videoKey = (hash, ext) => `${hash}.${ext}`;

/**
 * Get (or create) a <video> for an asset.
 *
 * @param {() => void} [onReady] fired when the first frame is decodable
 */
export function getVideo(base, hash, ext, { loop = false, muted = false, onReady } = {}) {
  const key = videoKey(hash, ext);
  const hit = videoCache.get(key);

  if (hit) {
    videoCache.delete(key);
    videoCache.set(key, hit); // touch: insertion order is LRU order
    hit.loop = loop;
    hit.muted = muted;
    if (hit.readyState < 2 && onReady) hit.addEventListener('loadeddata', onReady, { once: true });
    return hit;
  }

  const video = document.createElement('video');
  video.src = `${base}/${hash}.${ext}`;
  video.loop = loop;
  video.muted = muted;
  // Without playsInline, iOS Safari hijacks playback into a fullscreen player and
  // the canvas draws nothing.
  video.playsInline = true;
  // 'auto', not 'metadata': the editor draws a poster frame while paused, and
  // metadata alone gives dimensions but no pixels.
  video.preload = 'auto';

  if (onReady) video.addEventListener('loadeddata', onReady, { once: true });
  video.addEventListener('error', () => videoCache.delete(key), { once: true });

  videoCache.set(key, video);
  evictVideos();
  return video;
}

function releaseVideo(video) {
  // Pausing is not enough — the decoder lives on until the source is dropped.
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function evictVideos() {
  while (videoCache.size > MAX_VIDEOS) {
    const oldest = videoCache.keys().next().value;
    releaseVideo(videoCache.get(oldest));
    videoCache.delete(oldest);
  }
}

/** Release every decoder. Called when a project closes. */
export function clearVideoCache() {
  for (const video of videoCache.values()) releaseVideo(video);
  videoCache.clear();
}

export const videoCacheSize = () => videoCache.size;

/* -------------------------------------------------------------------------- */

export class AE1Video extends AE1Element {
  /* -- the element ------------------------------------------------------- */

  /** The live <video>, or null if this element names no asset. */
  get videoEl() {
    const name = this.video || this.components?.video?.media;
    if (!name) return null;

    // Resolve by name; fall back to treating it as a hash ONLY if it looks like
    // one. Blindly falling back built `intro.mp4.mp4` from the name and silently
    // rendered black -- a wrong URL should be a warning, not a plausible-looking
    // 404.
    const m =
      this.world?.resolveMedia?.(name) ??
      (/^[0-9a-f]{8,}$/.test(name)
        ? { hash: name, ext: this.components?.video?.ext ?? 'mp4' }
        : null);

    if (!m) {
      if (!this._warnedMissing) {
        this._warnedMissing = true; // once, not once per frame
        console.warn(`[ags] Video "${this.name}" — no media named "${name}".`);
      }
      return null;
    }

    const el = getVideo(this.world?.mediaBase ?? 'media', m.hash, m.ext, {
      loop: Boolean(this.loop),
      muted: Boolean(this.muted),
      onReady: () => this._notify('@redraw', true, null),
    });

    // Park on the poster frame while at rest.
    //
    // "At rest" is the editor, where nothing ticks and nothing calls onLoad, so a
    // video sits on frame 0 forever -- and frame 0 of an intro is usually black.
    // An author laying a title over it is positioning against nothing.
    //
    // Once, not per draw: this getter runs every frame, and re-seeking a video 60
    // times a second would fight the decoder and never settle.
    if (!this._posterDone && el.paused) {
      this._posterDone = true;
      this._seekWhenReady(this.poster);
    }

    return el;
  }

  /**
   * Seek, once the browser will actually allow it.
   *
   * `readyState === 4` (HAVE_ENOUGH_DATA) does NOT imply seekable. On a first
   * load the browser reports the whole file buffered while `seekable` is still
   * empty, and assigning currentTime then does NOTHING -- no error, no event, and
   * currentTime reads back 0.
   *
   * That cost real time to find: the frame looked "stuck at 0", and the file, the
   * server's Range support, and the encoder all looked guilty long before the
   * actual culprit, which was asking one beat too early. The same asset seeks
   * perfectly on its second load, when it comes from the HTTP cache -- which is
   * exactly the sort of works-on-my-machine difference that ships broken.
   */
  _seekWhenReady(time) {
    const v = this.videoEl;
    if (!v) return;

    const want = Math.max(0, Number(time) || 0);

    const attempt = () => {
      if (!v.seekable?.length) return false;

      const end = v.seekable.end(v.seekable.length - 1);
      if (!(end > 0)) return false;

      // Clamp inside the media. A poster past the end seeks to nothing and
      // leaves the frame wherever it already was, which reads as "poster is
      // broken" rather than "that time does not exist".
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : end;
      try {
        v.currentTime = Math.min(want, Math.max(0, dur - 0.05));
      } catch {
        return false; // not seekable after all; a listener below will retry
      }
      return true;
    };

    if (attempt()) return;

    // Not seekable yet. `progress` fires as the buffer grows; the others cover
    // the case where it became seekable before any progress event landed.
    const retry = () => {
      if (attempt()) stop();
    };
    const stop = () => {
      for (const ev of ['progress', 'canplay', 'loadeddata', 'durationchange']) {
        v.removeEventListener(ev, retry);
      }
    };
    for (const ev of ['progress', 'canplay', 'loadeddata', 'durationchange']) {
      v.addEventListener(ev, retry);
    }
  }

  /**
   * The frame shown at rest, in seconds.
   *
   * A real accessor rather than a generated one, because changing it has to DO
   * something: the Properties panel writes `element.poster = 2.5` and the author
   * expects the picture to move. defineDatAccessors skips a key the class already
   * defines, so this wins.
   */
  get poster() {
    return this._props.poster;
  }

  set poster(value) {
    const old = this._props.poster;
    if (old === value) return;

    this._props.poster = value;
    this._posterDone = true;
    this._seekWhenReady(value);
    this._notify('poster', value, old);
  }

  /* -- playback ---------------------------------------------------------- */

  play() {
    const v = this.videoEl;
    if (!v) return false;

    v.play?.().catch(() => {
      // Refused: unmuted video needs a gesture, same as audio. Hold the intent.
      if (hasGestured()) return;
      this._cancelUnlock?.();
      this._cancelUnlock = onFirstGesture(() => {
        this._cancelUnlock = null;
        this.videoEl?.play?.().catch(() => {});
      });
    });
    return true;
  }

  pause() {
    this.videoEl?.pause?.();
  }

  /** Back to the first frame, paused. */
  rewind() {
    const v = this.videoEl;
    if (!v) return;
    try {
      v.currentTime = 0;
    } catch {
      /* not seekable yet; the reset on next load covers it */
    }
  }

  get duration() {
    return this.videoEl?.duration ?? 0;
  }

  get currentTime() {
    return this.videoEl?.currentTime ?? 0;
  }

  set currentTime(t) {
    const v = this.videoEl;
    if (v) {
      try {
        v.currentTime = t;
      } catch {
        /* ignore */
      }
    }
  }

  /* -- lifecycle --------------------------------------------------------- */
  //
  // These fire because AE1Video declares a static agsDef below. A built-in class
  // has no compiled def, so buildSchedule would skip it entirely and a Video with
  // no script attached would never start.

  _videoBegin() {
    const v = this.videoEl;
    if (!v) return;

    this._ended = false;
    this._onEnded ??= () => {
      this._ended = true;
      // Dispatch through the loop so an author writes `(runInfo finish onEnded)`
      // like any other mode, rather than learning a video-only convention.
      this.world?.loop?.dispatchTo?.(this, 'onEnded', this);
    };
    v.addEventListener('ended', this._onEnded);

    this.rewind();
    if (this.autoplay !== false) this.play();
  }

  _videoEnd() {
    const v = this.videoEl;
    if (v && this._onEnded) v.removeEventListener('ended', this._onEnded);

    this._cancelUnlock?.();
    this._cancelUnlock = null;

    // Pause on scene exit, always. A video left playing behind a scene nobody is
    // looking at keeps a decoder busy forever -- exactly the leak onUnload exists
    // to prevent (DESIGN.md §6.3).
    this.pause();

    // Back to the poster, not to zero: stopping Play in the editor should leave
    // the author looking at the frame they chose to lay out against, which is the
    // whole reason the poster exists.
    this._posterDone = true;
    this._seekWhenReady(this.poster);
  }

  /** Did this video reach its end? False forever while looping. */
  get ended() {
    return Boolean(this._ended);
  }

  /* -- rendering --------------------------------------------------------- */

  draw(ctx, api) {
    const v = this.videoEl;

    // readyState < 2 means no frame is decodable yet. Black beats a flash of
    // whatever was underneath, which is what a bumper is supposed to look like.
    if (!v || v.readyState < 2) {
      ctx.fillStyle = this.background ?? '#000';
      ctx.fillRect(0, 0, api.width, api.height);
      return;
    }

    if (this.fit === 'contain') {
      // Letterbox inside our own bounds, preserving the source aspect.
      const scale = Math.min(api.width / v.videoWidth, api.height / v.videoHeight);
      const w = v.videoWidth * scale;
      const h = v.videoHeight * scale;
      ctx.fillStyle = this.background ?? '#000';
      ctx.fillRect(0, 0, api.width, api.height);
      ctx.drawImage(v, (api.width - w) / 2, (api.height - h) / 2, w, h);
    } else {
      // Default: fill the element. Sized to the frame, that is what you want.
      ctx.drawImage(v, 0, 0, api.width, api.height);
    }
  }
}

/**
 * Static def, so a Video works with NO script attached.
 *
 * buildSchedule reads `constructor.agsDef`; built-ins have no compiled def, so
 * without this a bare Video element would never start or stop. buildClass merges
 * `Base.agsDef.runInfo` down the chain, so a script that `(extends Video)`
 * inherits these too — and can add its own `(runInfo finish onEnded)` beside them.
 */
AE1Video.agsDef = {
  name: 'Video',
  extends: null,
  runInfo: {
    _videoBegin: ['onLoad'],
    _videoEnd: ['onUnload'],
  },
};

/** Defaults for a bare Video, mirroring how a compiled script's dat would arrive. */
AE1Video.agsDat = {
  video: '',
  loop: false,
  muted: false,
  autoplay: true,
  fit: 'fill',
  background: '#000000',

  // The frame the EDITOR shows, in seconds. Play always starts from 0.
  //
  // Authoring metadata that lives in dat on purpose: it is the author's choice,
  // it belongs to this element, it survives in the file, and it appears in the
  // Properties panel for free. The viewport's "Set poster" button writes it.
  poster: 0,
};

// Built-ins must define their own dat accessors. buildClass does this for
// compiled scripts, but a bare Video never goes through the compiler -- without
// this its dat would sit in _props with nothing able to read it, and `this.video`
// would be undefined on the element that owns the video.
defineDatAccessors(AE1Video);
