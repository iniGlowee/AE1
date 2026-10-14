/**
 * AE1 - server API client.
 *
 * The single doorway to the filesystem. Every read and write in the editor goes
 * through here, because the filesystem is the only source of truth (DESIGN.md,
 * Principle 1). If a view ever reaches around this module to stash state in the
 * browser, that is the architecture breaking.
 */

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    // fetch only rejects when the server is unreachable. Say that plainly rather
    // than surfacing "Failed to fetch", which tells the user nothing actionable.
    throw new ApiError('Cannot reach the AE1 server. Is server.ps1 still running?', 0, cause);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(`Server sent a malformed response for ${method} ${path}.`, res.status);
    }
  }

  if (!res.ok) {
    throw new ApiError(data?.error || `${method} ${path} failed (${res.status})`, res.status);
  }

  return data;
}

export class ApiError extends Error {
  constructor(message, status = 0, cause = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.cause = cause;
  }
}

export const api = {
  status: () => request('GET', '/api/status'),

  getSettings: () => request('GET', '/api/settings'),
  patchSettings: (patch) => request('PATCH', '/api/settings', patch),

  listProjects: () => request('GET', '/api/projects'),
  getProject: (slug) => request('GET', `/api/projects/${slug}`),
  createProject: (payload) => request('POST', '/api/projects', payload),
  updateProject: (slug, patch) => request('PATCH', `/api/projects/${slug}`, patch),
  deleteProject: (slug) => request('DELETE', `/api/projects/${slug}`),
  /** MANAGER-PROJECT-01 W4: copy to a new name and slug; the original is untouched. */
  copyProject: (slug, name) => request('POST', `/api/projects/${slug}/copy`, { name }),

  /** Mark a project as most-recently-opened. Drives the project list ordering. */
  touchProject: (slug) => request('PATCH', `/api/projects/${slug}`, { opened: true }),

  exportProject: (slug) => request('POST', `/api/projects/${slug}/export`, {}),

  listMedia: (slug) => request('GET', `/api/projects/${slug}/media`),
  patchMedia: (slug, hash, patch) => request('PATCH', `/api/projects/${slug}/media/${hash}`, patch),
  deleteMedia: (slug, hash) => request('DELETE', `/api/projects/${slug}/media/${hash}`),

  /**
   * Import one file, posted as a raw body.
   *
   * Not multipart: the stdlib's parser was removed in Python 3.13, and the
   * browser can post a File directly. The name rides in a header, percent-encoded
   * because headers are latin-1 only and asset names are full of spaces, accents,
   * and CJK.
   */
  async uploadMedia(slug, file) {
    const res = await fetch(`/api/projects/${slug}/media`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
      },
      body: file,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(data?.error ?? `Upload failed (${res.status})`, res.status);
    return data;
  },

  listScripts: (slug) => request('GET', `/api/projects/${slug}/scripts`),
  putScript: (slug, file, content) =>
    request('PUT', `/api/projects/${slug}/scripts/${file}`, { content }),
  deleteScript: (slug, file) => request('DELETE', `/api/projects/${slug}/scripts/${file}`),

  /** MANAGER-PROJECT-01: the shipped sample a project came from, and its scripts. */
  getSample: (slug) => request('GET', `/api/projects/${slug}/sample`),
  getSampleScript: (slug, file) => request('GET', `/api/projects/${slug}/sample/scripts/${file}`),
  /** W5: what a restore would lose, in the user's terms; then the restore itself. */
  getSampleDiff: (slug) => request('GET', `/api/projects/${slug}/sample/diff`),
  restoreSample: (slug) => request('POST', `/api/projects/${slug}/sample/restore`, {}),

  listScenes: (slug) => request('GET', `/api/projects/${slug}/scenes`),
  getScene: (slug, file) => request('GET', `/api/projects/${slug}/scenes/${file}`),
  putScene: (slug, file, data) => request('PUT', `/api/projects/${slug}/scenes/${file}`, data),
  createScene: (slug, name) => request('POST', `/api/projects/${slug}/scenes`, { name }),
  deleteScene: (slug, file) => request('DELETE', `/api/projects/${slug}/scenes/${file}`),

  /** The persistent element layer. Outlives every scene change. */
  getHud: (slug) => request('GET', `/api/projects/${slug}/hud`),
  putHud: (slug, data) => request('PUT', `/api/projects/${slug}/hud`, data),

  /**
   * Saves. EDITOR ONLY — a shipped game has no server and hands the player a
   * file instead. Same `saveGame()` in the script; different host.
   */
  listSaves: (slug) => request('GET', `/api/projects/${slug}/saves`),
  getSave: (slug, file) => request('GET', `/api/projects/${slug}/saves/${file}`),
  createSave: (slug, name, data) => request('POST', `/api/projects/${slug}/saves`, { name, data }),
  deleteSave: (slug, file) => request('DELETE', `/api/projects/${slug}/saves/${file}`),
};
