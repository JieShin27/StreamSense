'use client';

import { useEffect, useRef, useState } from 'react';
import { useBroadcast } from '@/components/liveVideo';
import { act } from '@/components/useLiveState';
import type { LiveState } from '@/lib/types';

// The seller's camera and microphone. Going live starts both. What she says is
// turned into text and sent to the agents, who warn her on this screen when it
// does not match her prices, stock or confirmed facts.

// "mixed" records short clips and sends them to a multilingual speech model, so
// she can switch language mid-sentence. The others use the browser's own
// recognition: instant, but one language at a time.
const LANGS = [
  { code: 'ms-MY', label: 'BM' },
  { code: 'en-US', label: 'English' },
  { code: 'zh-CN', label: '中文' },
  { code: 'mixed', label: 'Mixed (slower, less accurate)' },
];
const CLIP_MS = 6000;
const QUIET = 0.015;
const WARNING_MS = 10000;

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

function createRecognition(): Recognition | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

function useTick(ms: number, on: boolean): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, on]);
  return t;
}

function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => ctx.close();
  } catch {}
}

export function SellerStudio({ state }: { state: LiveState }) {
  const video = useRef<HTMLVideoElement>(null);
  const recog = useRef<Recognition | null>(null);
  const wantMic = useRef(false);
  const clip = useRef<{ stop: () => void } | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const broadcast = useBroadcast(stream);
  const [micOn, setMicOn] = useState(false);
  const [lang, setLang] = useState(LANGS[0].code);
  const [interim, setInterim] = useState('');
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');

  const live = state.session.status === 'live';
  const nowMs = useTick(1000, live);
  const secs = Math.max(0, Math.floor((nowMs - Date.parse(state.session.startedAt)) / 1000));
  const clock = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  const lastSaid = state.transcript[state.transcript.length - 1];

  // The newest warning about something she said stays across her video for a few seconds.
  const warning = [...state.alerts].reverse().find((a) => (a.kind === 'monitor' || a.kind === 'policy') && nowMs - Date.parse(a.ts) < WARNING_MS);
  const lastWarned = useRef('');
  useEffect(() => {
    if (warning && warning.id !== lastWarned.current) {
      lastWarned.current = warning.id;
      beep();
    }
  }, [warning]);

  async function startCamera(): Promise<MediaStream | null> {
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
      if (video.current) video.current.srcObject = media;
      setStream(media);
      return media;
    } catch {
      setNote('Camera or microphone was blocked. You are live with comments only — allow access in the browser to add video.');
      return null;
    }
  }

  function stopCamera() {
    stream?.getTracks().forEach((t) => t.stop());
    if (video.current) video.current.srcObject = null;
    setStream(null);
  }

  function stopMic() {
    wantMic.current = false;
    recog.current?.stop();
    recog.current = null;
    clip.current?.stop();
    clip.current = null;
    setMicOn(false);
    setInterim('');
  }

  /** Mixed-language listening: record a few seconds, skip silence, send the clip to be transcribed, repeat. */
  async function startClips(media: MediaStream | null) {
    let source = media;
    let own: MediaStream | null = null;
    if (!source || source.getAudioTracks().length === 0) {
      try {
        own = await navigator.mediaDevices.getUserMedia({ audio: true });
        source = own;
      } catch {
        setNote('Microphone was blocked. Allow access in the browser, or type what you say below.');
        return;
      }
    }
    const audio = new MediaStream(source.getAudioTracks());
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(audio).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    const meter = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      peak = Math.max(peak, Math.sqrt(sum / buf.length));
    }, 150);

    let recorder: MediaRecorder | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';

    const record = () => {
      if (!wantMic.current) return;
      const parts: Blob[] = [];
      peak = 0;
      recorder = new MediaRecorder(audio, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
      recorder.onstop = async () => {
        const loud = peak > QUIET;
        // Start the next clip straight away so nothing she says is lost while this one uploads.
        record();
        if (!loud || parts.length === 0) return;
        setInterim('…');
        try {
          const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': parts[0].type || 'audio/webm' }, body: new Blob(parts, { type: parts[0].type }) }).then((r) => r.json());
          if (!res.ok && res.error) setNote(res.error);
        } catch {
          setNote('Could not reach the speech service.');
        } finally {
          setInterim('');
        }
      };
      recorder.start();
      timer = setTimeout(() => recorder?.state === 'recording' && recorder.stop(), CLIP_MS);
    };

    clip.current = {
      stop: () => {
        clearTimeout(timer);
        clearInterval(meter);
        if (recorder?.state === 'recording') recorder.stop();
        own?.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
      },
    };
    wantMic.current = true;
    setMicOn(true);
    record();
  }

  function startBrowser(code: string) {
    const r = createRecognition();
    if (!r) {
      setNote('This browser cannot transcribe speech by itself. Choose Mixed, or type what you say below.');
      return;
    }
    r.lang = code;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let partial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) act({ type: 'speech', text: res[0].transcript });
        else partial += res[0].transcript;
      }
      setInterim(partial);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setNote('Microphone was blocked. Allow access in the browser, or type what you say below.');
        stopMic();
      }
    };
    // The browser stops listening after a pause; keep going while the mic is on.
    r.onend = () => {
      if (wantMic.current) {
        try {
          r.start();
        } catch {}
      }
    };
    recog.current = r;
    wantMic.current = true;
    try {
      r.start();
      setMicOn(true);
    } catch {
      setNote('Could not start the transcript.');
    }
  }

  function startMic(code: string, media: MediaStream | null = stream) {
    setNote('');
    if (code === 'mixed') void startClips(media);
    else startBrowser(code);
  }

  async function goLive() {
    setNote('');
    const media = await startCamera();
    await act({ type: 'go_live' });
    startMic(lang, media);
  }

  async function endLive() {
    if (!window.confirm('End the live? Buyers keep their carts and you go to the wrap-up.')) return;
    stopMic();
    stopCamera();
    await act({ type: 'end_live' });
    window.location.href = '/wrapup';
  }

  function changeLang(code: string) {
    setLang(code);
    if (micOn) {
      stopMic();
      setTimeout(() => startMic(code), 300);
    }
  }

  useEffect(() => () => {
    wantMic.current = false;
    recog.current?.stop();
    clip.current?.stop();
  }, []);

  const videoNote =
    broadcast.status === 'connecting' ? 'Connecting video…'
      : broadcast.status === 'unavailable' ? 'Preview only'
        : broadcast.status === 'failed' ? 'Video link failed'
          : '';
  const caption = interim && interim !== '…' ? interim : lastSaid?.text;

  return (
    <div className="studio">
      <div className={`stage ${stream ? '' : 'idle'} ${warning ? 'warned' : ''}`}>
        <video ref={video} autoPlay muted playsInline />
        <div className="stage-top">
          {live ? <span className="live-badge">LIVE {clock}</span> : <span className="pill">{state.session.status === 'ended' ? 'Ended' : 'Not live'}</span>}
          {broadcast.status === 'live' && <span className="pill">{broadcast.viewers} watching</span>}
          {videoNote && <span className="pill">{videoNote}</span>}
          {micOn && <span className="pill">{interim === '…' ? 'transcribing…' : 'listening'}</span>}
        </div>
        {!stream && !warning && <p className="stage-hint">{live ? 'Camera is off' : 'Your camera appears here when you go live'}</p>}
        {warning ? (
          <div className="stage-warning" role="alert">
            <b>{warning.by ?? 'Warning'}</b>
            {warning.text}
          </div>
        ) : (
          caption && live && <p className={`caption ${!interim && lastSaid?.flag ? 'flagged' : ''}`}>{caption}</p>
        )}
      </div>

      {!live ? (
        <button className="primary big" onClick={goLive}>{state.session.status === 'ended' ? 'Go live again' : 'Go live'}</button>
      ) : (
        <div className="studio-controls">
          {!stream && <button onClick={() => void startCamera()}>Start camera</button>}
          <button className={micOn ? 'recording' : ''} onClick={() => (micOn ? stopMic() : startMic(lang))}>
            {micOn ? '● Listening' : 'Listening off'}
          </button>
          <select value={lang} onChange={(e) => changeLang(e.target.value)} aria-label="Language you speak">
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
          <button className="danger" onClick={endLive}>End live</button>
        </div>
      )}
      {note && <p className="verdict bad">{note}</p>}

      {live && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const text = typed.trim();
            if (!text) return;
            setTyped('');
            act({ type: 'speech', text });
          }}
        >
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Noisy room? Type what you say" aria-label="Type what you say" />
          <button className="small" type="submit">Say</button>
        </form>
      )}
    </div>
  );
}
