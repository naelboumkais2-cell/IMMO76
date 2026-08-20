// Intégration RÉELLE de la publication vers Hubiflow — appelle Ubiflow-Auto-API/server.js en
// HTTP (comme processOtareeFolder s'appelle déjà lui-même en HTTP dans ce même fichier), pas
// d'import direct : server.js est un script CommonJS qui démarre son propre serveur/watcher dès
// qu'on le charge, pas une librairie exportable telle quelle.
//
// Même contrat que hubiflowClient.js (mock) : publish(annonce, portail, mode, opts) ->
// { success: true, adId } | { success: false, error }
//
// N'est utilisé que si hubiflowRouter.js bascule en mode 'reel' (HUBIFLOW_MODE=reel).

const SERVER_URL = process.env.UBIFLOW_AUTO_API_URL || 'http://localhost:4000';

export async function publish(annonce, portail, mode, opts = {}) {
    // Whitelist explicite : seules les annonces marquées "test" peuvent déclencher un vrai
    // appel réseau vers Hubiflow — SAUF si l'appelant est orchestrator.autoGenererEtPublier en
    // mode AUTO_PUBLISH=on (opts.autoriseAutoPublishOn), le seul chemin explicitement conçu et
    // validé (paliers 1-4) pour publier des lots réellement nouveaux, jamais marqués test par
    // nature. Tout autre appelant (republish manuel, etc.) reste soumis à la whitelist.
    if (!annonce.est_annonce_test && !opts.autoriseAutoPublishOn) {
        return { success: false, error: "Cette annonce n'est pas marquée comme annonce de test — publication réelle refusée." };
    }

    if (!annonce.donnees_ia) {
        return { success: false, error: "Pas de données enrichies (donnees_ia) pour cette annonce — impossible de construire un payload réel." };
    }

    let aiData;
    let images;
    try {
        aiData = JSON.parse(annonce.donnees_ia);
        images = annonce.images ? JSON.parse(annonce.images) : [];
    } catch (e) {
        return { success: false, error: `donnees_ia/images illisibles : ${e.message}` };
    }

    try {
        const res = await fetch(`${SERVER_URL}/api/publish-payload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                aiData,
                base64Images: images,
                villeConnue: annonce.ville,
                codePostalConnu: annonce.code_postal,
                espaceLoginAttendu: portail.login,
                mode,
            }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
            // actif/erreurActivation : présents seulement si mode === 'actif' était demandé —
            // permet à l'appelant de distinguer "brouillon créé, activation en échec" d'une
            // vraie publication complète (voir orchestrator.publierInstance).
            return { success: true, adId: data.adId, actif: data.actif, erreurActivation: data.erreurActivation };
        }
        return { success: false, error: data.error || `Erreur HTTP ${res.status}` };
    } catch (e) {
        return { success: false, error: `Ubiflow-Auto-API injoignable (${SERVER_URL}) : ${e.message}` };
    }
}

// Lecture seule : interroge l'état réel sur Hubiflow (pas de mutation) — utilisé pour
// resynchroniser le dashboard si un changement a été fait directement sur Hubiflow.
export async function lireEtat(adId, portail) {
    try {
        const res = await fetch(`${SERVER_URL}/api/annonce/${adId}/etat?espaceLoginAttendu=${encodeURIComponent(portail.login)}`);
        const data = await res.json();
        if (res.ok && data.success) {
            return { success: true, etat: data.etat };
        }
        return { success: false, error: data.error || `Erreur HTTP ${res.status}` };
    } catch (e) {
        return { success: false, error: `Ubiflow-Auto-API injoignable (${SERVER_URL}) : ${e.message}` };
    }
}

// Retour arrière immédiat : dépublie/supprime une annonce déjà publiée sur Hubiflow (STATUS
// "S"). Chemin séparé et minimal de publish() — ne dépend pas de donnees_ia/aiData, juste de
// l'adId déjà connu, pour rester rapide et fiable au moment où on en a besoin en urgence.
export async function depublier(adId, portail) {
    try {
        const res = await fetch(`${SERVER_URL}/api/annonce/${adId}/depublier`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ espaceLoginAttendu: portail.login }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
            return { success: true };
        }
        return { success: false, error: data.error || `Erreur HTTP ${res.status}` };
    } catch (e) {
        return { success: false, error: `Ubiflow-Auto-API injoignable (${SERVER_URL}) : ${e.message}` };
    }
}
