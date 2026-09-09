/**
 * The built-in notification chime.
 *
 * Deliberately tiny: Web Audio only, so there is no audio file to ship, no
 * package to install and nothing for the user to upload. One AudioContext is
 * created lazily on first use and reused.
 *
 * Browsers block audio until the user has interacted with the page, so
 * `primeNotificationSound()` exists to be called from a real user gesture —
 * the Settings toggle and the bell click — which resumes a suspended context.
 * Every failure path is silent: a browser without Web Audio simply gets no
 * sound, never an error.
 */

type AudioContextCtor = typeof AudioContext;

let context: AudioContext | null = null;
let unavailable = false;

function resolveCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;

  const scope = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };

  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function getContext(): AudioContext | null {
  if (unavailable) return null;
  if (context) return context;

  const Ctor = resolveCtor();
  if (!Ctor) {
    unavailable = true;
    return null;
  }

  try {
    context = new Ctor();
    return context;
  } catch {
    unavailable = true;
    return null;
  }
}

function scheduleTone(ctx: AudioContext, frequency: number, start: number, duration: number) {
  try {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);

    // Short attack + exponential decay: no clicks, no abrupt cut-off.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  } catch {
    // A failed chime must never break the notification itself.
  }
}

function play(ctx: AudioContext) {
  const start = ctx.currentTime + 0.01;
  scheduleTone(ctx, 880, start, 0.14);
  scheduleTone(ctx, 1174.66, start + 0.13, 0.22);
}

/**
 * Call from a user gesture (toggle, click) so the context is allowed to run.
 * Safe to call repeatedly; does nothing when audio is unsupported.
 */
export function primeNotificationSound(): void {
  const ctx = getContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
  }
}

/** Plays the two-tone chime. No-op when unsupported or still blocked. */
export function playNotificationSound(): void {
  const ctx = getContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    void ctx
      .resume()
      .then(() => play(ctx))
      .catch(() => undefined);
    return;
  }

  play(ctx);
}
