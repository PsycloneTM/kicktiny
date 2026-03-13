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
  return get(`/api/v2/channels/${username}`);
}

export async function fetchChannelInit(username) {
  try {
    const data = await fetchChannelInfo(username);
    const ls = data?.livestream ?? null;
    return {
      isLive: ls !== null,
      displayName: data?.user?.username ?? null,
      avatar: data?.user?.profile_pic ?? null,
      livestreamId: ls?.id ?? null,
      viewers: ls?.viewer_count ?? null,
      startTime: ls?.start_time ?? null,
      title: ls?.session_title ?? null,
    };
  } catch {
    return { isLive: null, displayName: null, avatar: null, livestreamId: null, viewers: null, startTime: null, title: null };
  }
}

export async function fetchViewerCount(livestreamId) {
  try {
    const res = await fetch(
      `${BASE}/current-viewers?ids[]=${encodeURIComponent(livestreamId)}`,
      { credentials: 'omit', headers: { 'Accept': 'application/json' } },
    );
    if (!res.ok) throw new Error(`${res.status} /current-viewers`);
    const data = await res.json();
    const row = Array.isArray(data)
      ? data.find(x => x?.livestream_id === livestreamId)
      : null;
    return row?.viewers ?? null;
  } catch {
    return null;
  }
}
