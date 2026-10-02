import { record, RESOURCE } from './auth/protocol.ts';
export interface Model { slug: string; name: string }
export async function listModels(accessToken: string, transport: typeof fetch = fetch): Promise<Model[]> {
  const response = await transport(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}. Check ChatGPT plan permissions or try again later. No API-key fallback is available.`);
  const body = record(await response.json());
  if (!Array.isArray(body.models)) throw new Error('Unexpected subscription model catalog. Expected models[].');
  const models = body.models.map(record).filter(m => m.visibility === 'list' && typeof m.slug === 'string' && typeof m.display_name === 'string').map(m => ({ slug: String(m.slug), name: String(m.display_name) }));
  if (!models.length) throw new Error('No selectable models are available to this ChatGPT account.');
  return models;
}
