'use client';

import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import type { RemoteTrack } from 'livekit-client';

// Live video from the seller's camera to every buyer, through a managed video
// room. Entirely optional: with no video keys set, both sides simply skip it.

/** `prepare` runs before connecting, so listeners catch tracks that are already being published. */
async function join(role: 'host' | 'viewer', name: string, prepare?: (room: Room) => void): Promise<Room | null> {
  const res = await fetch(`/api/live-token?role=${role}&name=${encodeURIComponent(name)}`, { cache: 'no-store' }).then((r) => r.json());
  if (!res.enabled) return null;
  const room = new Room({ dynacast: role === 'host' });
  prepare?.(room);
  await room.connect(res.url, res.token);
  return room;
}

export type Broadcast = 'off' | 'connecting' | 'live' | 'unavailable' | 'failed';

/** Seller side: while `stream` is set, publish its camera and microphone to the room. */
export function useBroadcast(stream: MediaStream | null): { status: Broadcast; viewers: number } {
  const [status, setStatus] = useState<Broadcast>('off');
  const [viewers, setViewers] = useState(0);

  useEffect(() => {
    if (!stream) {
      setStatus('off');
      return;
    }
    let room: Room | null = null;
    let cancelled = false;
    setStatus('connecting');

    (async () => {
      try {
        room = await join('host', 'seller');
        if (!room) return setStatus('unavailable');
        if (cancelled) return void room.disconnect();
        const count = () => setViewers(room!.remoteParticipants.size);
        room.on(RoomEvent.ParticipantConnected, count).on(RoomEvent.ParticipantDisconnected, count);
        count();
        for (const track of stream.getTracks()) {
          await room.localParticipant.publishTrack(track, {
            source: track.kind === 'video' ? Track.Source.Camera : Track.Source.Microphone,
          });
        }
        if (!cancelled) setStatus('live');
      } catch (err) {
        console.warn('video broadcast failed:', err);
        if (!cancelled) setStatus('failed');
      }
    })();

    return () => {
      cancelled = true;
      room?.disconnect();
      setViewers(0);
    };
  }, [stream]);

  return { status, viewers };
}

/** Buyer side: the seller's video, with a tap to turn sound on (browsers block autoplay with sound). */
export function ViewerVideo({ name, caption }: { name: string; caption: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const room = useRef<Room | null>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;

    const show = (track: RemoteTrack) => {
      if (cancelled) return;
      if (track.kind === Track.Kind.Video && video.current) {
        track.attach(video.current);
        setHasVideo(true);
      } else if (track.kind === Track.Kind.Audio && audio.current) {
        track.attach(audio.current);
      }
    };

    (async () => {
      try {
        const r = await join('viewer', name, (room) => {
          room.on(RoomEvent.TrackSubscribed, show);
          room.on(RoomEvent.TrackUnsubscribed, (track) => {
            track.detach();
            if (track.kind === Track.Kind.Video) setHasVideo(false);
          });
          room.on(RoomEvent.AudioPlaybackStatusChanged, () => setMuted(!room.canPlaybackAudio));
        });
        if (!r) return;
        if (cancelled) return void r.disconnect();
        room.current = r;
        // The seller may have been live before this buyer arrived.
        for (const participant of r.remoteParticipants.values()) {
          for (const pub of participant.trackPublications.values()) {
            if (pub.track) show(pub.track as RemoteTrack);
          }
        }
        setMuted(!r.canPlaybackAudio);
      } catch (err) {
        console.warn('could not join the video room:', err);
      }
    })();

    return () => {
      cancelled = true;
      room.current?.disconnect();
      room.current = null;
    };
    // Join once per page load; renaming mid-live should not drop the video.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name !== '']);

  return (
    <div className="stage" id="live-video">
      <video ref={video} autoPlay playsInline muted style={{ visibility: hasVideo ? 'visible' : 'hidden' }} />
      <audio ref={audio} autoPlay />
      <span>{hasVideo ? caption : `${caption} · waiting for the seller’s camera`}</span>
      {hasVideo && muted && (
        <button className="small unmute" onClick={() => room.current?.startAudio().then(() => setMuted(false))}>
          Tap for sound
        </button>
      )}
    </div>
  );
}
