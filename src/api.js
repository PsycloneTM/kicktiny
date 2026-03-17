const BASE = 'https://kick.com';

async function get(path) {
  const res = await fetch(BASE + path, {
    credentials: 'omit',
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

export async function fetchChannelInfo(username) {
  return get(`/api/v2/channels/${username}/info`);
}

export async function fetchChannelInit(username) {
  try {
    const data = await fetchChannelInfo(username);
    const ls = data?.livestream ?? null;
    return {
      isLive:       ls?.is_live === true,
      displayName:  data?.user?.username    ?? null,
      avatar:       data?.user?.profile_pic ?? null,
      vodId:        ls?.vod_id              ?? null,
      livestreamId: ls?.id                  ?? null,
      viewers:      ls?.viewer_count        ?? null,
      startTime:    ls?.start_time          ?? null,
      title:        ls?.session_title       ?? null,
    };
  } catch {
    return { isLive: null, displayName: null, avatar: null, vodId: null, livestreamId: null, viewers: null, startTime: null, title: null };
  }
}

function getDeviceId() {
  const KEY = 'kt.deviceId';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

export async function fetchVodPlaybackUrl(vodId) {
  try {
    const res = await fetch(
      `https://web.kick.com/api/v1/stream/${encodeURIComponent(vodId)}/playback`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Accept':       'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          video_player: {
            player: {
              player_name:             'web',
              player_version:          'web_7a224cf6',
              player_software:         'IVS Player',
              player_software_version: '1.49.0',
            },
            mux_sdk:        { sdk_available: false },
            datazoom_sdk:   { sdk_available: false },
            google_ads_sdk: { sdk_available: false },
          },
          video_session: {
            page_type:              'channel',
            player_remote_played:   false,
            viewer_connection_type: '',
            enable_sampling:        false,
          },
          user_session: {
            player_device_id:               getDeviceId(),
            player_resettable_id:           '',
            player_resettable_consent_type: '',
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const dvr = data?.playback_url?.vod ?? null;
    if (!dvr) throw new Error('vod field missing from response');
    return dvr;
  } catch (e) {
    console.warn('[KickTiny DVR] fetchVodPlaybackUrl failed:', e.message);
    return null;
  }
}