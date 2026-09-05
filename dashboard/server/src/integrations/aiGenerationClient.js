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
    return {
        aiData: data.aiData,
        images: data.images,
        villeConnue: data.villeConnue,
        codePostalConnu: data.codePostalConnu,
        alerteConformite: data.alerteConformite || null,
    };
}

// Garde-fou "document ne correspond pas au lot" (voir Ubiflow-Auto-API/index.js,
// verifierDocumentsPlan) — PUREMENT INFORMATIF : ne throw jamais, un échec équivaut à "rien à
// signaler" plutôt qu'à un blocage. Appelé en parallèle de genererDonneesIA (voir orchestrator.js,
// executerTraitement), jamais après : sur un lot, les deux appels sont indépendants, les lancer en
// série ajouterait de la latence sans raison.
export async function verifierPlansLot(lotEnrichi) {
    try {
        const res = await fetch(`${SERVER_URL}/api/verifier-plans`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lot: lotEnrichi }),
        });
        const data = await res.json().catch(() => ({}));
        return data.alerte || null;
    } catch (e) {
        console.error('[verifierPlansLot] échec (ignoré, purement informatif) :', e.message);
        return null;
    }
}
