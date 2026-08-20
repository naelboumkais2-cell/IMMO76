async function request(path, options = {}) {
    const res = await fetch(`/api${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.erreur || `Erreur HTTP ${res.status}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

export const api = {
    // Scraper
    getRecherches: () => request('/scraper/recherches'),
    getRunsPourRecherche: (id) => request(`/scraper/recherches/${id}/runs`),
    setRechercheFrequence: (id, minutes) =>
        request(`/scraper/recherches/${id}/frequence`, { method: 'PUT', body: JSON.stringify({ minutes }) }),
    setRechercheFavori: (id, favori) =>
        request(`/scraper/recherches/${id}/favori`, { method: 'PUT', body: JSON.stringify({ favori }) }),
    getAlertes: () => request('/scraper/alertes'),
    marquerAlertesConsultees: () => request('/scraper/alertes/consultees', { method: 'POST' }),
    runScraper: (url) => request('/scraper/run', { method: 'POST', body: JSON.stringify({ url }) }),
    rechercherOtaree: (filters, nom, resume, confirmationRequise) =>
        request('/scraper/otaree-search', { method: 'POST', body: JSON.stringify({ filters, nom, resume, confirmationRequise }) }),
    compterOtaree: (filters) => request('/scraper/otaree-count', { method: 'POST', body: JSON.stringify({ filters }) }),
    rechercherVillesOtaree: (q) => request(`/scraper/otaree-locations?q=${encodeURIComponent(q)}`),
    getAutoPublishStatus: () => request('/scraper/auto-publish-status'),
    annulerAutoPublish: () => request('/scraper/auto-publish-cancel', { method: 'POST' }),
    confirmerAutoPublish: (idsSelectionnes, portailsChoisis) =>
        request('/scraper/auto-publish-confirm', { method: 'POST', body: JSON.stringify({ idsSelectionnes, portailsChoisis }) }),
    annulerAutoPublishEnAttente: () => request('/scraper/auto-publish-discard-pending', { method: 'POST' }),
    getLotDetail: (annonceId) => request('/scraper/lot-detail', { method: 'POST', body: JSON.stringify({ annonceId }) }),

    // Portails (= espaces Hubiflow)
    getPortails: () => request('/portails'),
    createPortail: (nom, login, mode_publication_defaut) =>
        request('/portails', { method: 'POST', body: JSON.stringify({ nom, login, mode_publication_defaut }) }),
    updatePortail: (id, patch) => request(`/portails/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    deletePortail: (id) => request(`/portails/${id}`, { method: 'DELETE' }),

    // Règles de routage
    getReglesRoutage: () => request('/portails/regles-routage'),
    createRegleRoutage: (type_bien, portail_id) =>
        request('/portails/regles-routage', { method: 'POST', body: JSON.stringify({ type_bien, portail_id }) }),
    deleteRegleRoutage: (id) => request(`/portails/regles-routage/${id}`, { method: 'DELETE' }),

    // Annonces / supervision — q optionnel : recherche par id/titre/ville, sans se limiter
    // aux 200 plus récentes (utile une fois la base à plusieurs milliers de lignes).
    getAnnonces: (q) => request(`/annonces${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    setAnnonceTest: (annonceId, estTest) =>
        request(`/annonces/${annonceId}`, { method: 'PUT', body: JSON.stringify({ est_annonce_test: estTest }) }),
    setInstanceMode: (annonceId, portailId, mode) =>
        request(`/annonces/${annonceId}/portails/${portailId}`, { method: 'PUT', body: JSON.stringify({ mode }) }),
    republish: (annonceId, portailId) =>
        request(`/annonces/${annonceId}/portails/${portailId}/republish`, { method: 'POST' }),
    depublier: (annonceId, portailId) =>
        request(`/annonces/${annonceId}/portails/${portailId}/depublier`, { method: 'POST' }),
    synchroniser: (annonceId, portailId) =>
        request(`/annonces/${annonceId}/portails/${portailId}/synchroniser`, { method: 'POST' }),

    // Logs
    getLogs: () => request('/logs'),

    // Mode Hubiflow (mock/réel) — pour afficher honnêtement l'état réel du bandeau
    getHubiflowMode: () => request('/hubiflow-mode'),
};
