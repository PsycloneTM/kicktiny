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

export async function fetchViewers(username) {
  try {
    const data = await fetchChannelInfo(username);
    return {
      viewers: data?.livestream?.viewer_count ?? null,
      startTime: data?.livestream?.start_time ?? null,
      title: data?.livestream?.session_title ?? null,
    };
  } catch {
    return { viewers: null, startTime: null, title: null };
  }
}
