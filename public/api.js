export async function api(requestPath, init) {
  const response = await fetch(requestPath, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

export async function uploadRequirementsZip(file) {
  const response = await fetch('/api/uploads/requirements-pack', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/zip',
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Upload failed (${response.status})`);
  return value;
}
