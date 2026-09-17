import { get, put } from '@vercel/blob';

export async function read() {
  // Identity encoding preserves the strong ETag required for conditional writes.
  const result = await get('live/current.json', { access: 'private', useCache: false, headers: { 'Accept-Encoding': 'identity' } });
  if (!result) return null;
  return { data: await new Response(result.stream).json(), etag: result.blob.etag };
}
export async function write(data, etag) {
  await put('live/current.json', JSON.stringify(data), {
    access: 'private', addRandomSuffix: false, allowOverwrite: !!etag,
    ...(etag ? { ifMatch: etag } : {}), contentType: 'application/json',
  });
}
export async function archive(data) {
  await put(`live/runs/${data.broadcastId}.json`, JSON.stringify(data), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
  });
}
