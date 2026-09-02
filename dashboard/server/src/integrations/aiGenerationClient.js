// Appelle Ubiflow-Auto-API/server.js (POST /api/generate) pour générer aiData+images à partir
// d'un lot Otaree déjà enrichi (voir enrichirLot dans otareeSearchClient.js) — même pattern
// HTTP « self-call » que hubiflowClientReel.js vers /api/publish-payload : server.js n'est pas
// une librairie importable, on réutilise donc son endpoint plutôt que de dupliquer le prompt IA.
const SERVER_URL = process.env.UBIFLOW_AUTO_API_URL || 'http://localhost:4000';

export async function genererDonneesIA(lotEnrichi, imagesSelection = null) {
    const res = await fetch(`${SERVER_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lot: lotEnrichi, imagesSelection }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        throw new Error(data.error || `Erreur HTTP ${res.status} lors de la génération IA`);
    }
    return { aiData: data.aiData, images: data.images, villeConnue: data.villeConnue, codePostalConnu: data.codePostalConnu };
}
