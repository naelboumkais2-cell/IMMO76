// Recherche Otaree directe, server-side, sans navigateur — utilise le refresh_token capturé
// par extension-chrome/Otaree/ (voir otareeTokenStore.js) pour s'auto-authentifier à la
// demande. Reproduit la logique de pagination/headers déjà éprouvée dans
// extension-chrome/Otaree/inject.js (fetch + suivi de hydra:view['hydra:next']), portée en
// Node — même comportement, pas de réinvention.
import { getOtareeCredentials } from './otareeTokenStore.js';

const API_BASE = 'https://api.link-app.immo';
const ORIGIN = 'https://plusimmo76.link-app.immo';
const REFERER = 'https://plusimmo76.link-app.immo/';
const SEARCH_PAGE_REFERER = 'https://plusimmo76.link-app.immo/estate/search/properties';
// Valeur observée dans une vraie capture DevTools — l'API ne semble pas la valider
// strictement (aucun rejet constaté en la rejouant depuis un serveur), gardée telle quelle
// pour coller exactement à ce qui a été testé avec succès.
const TIMEZONE = 'Asia/Singapore';

function buildHeaders(device, instanceId, jwt, accept = 'application/ld+json') {
    const headers = {
        Origin: ORIGIN,
        Referer: REFERER,
        'X-Timezone': TIMEZONE,
        'X-Referer': SEARCH_PAGE_REFERER,
        'Content-Type': 'application/json',
        Accept: accept,
    };
    if (device) headers['X-Device'] = device;
    if (instanceId) headers['X-Instance-Id'] = instanceId;
    if (jwt) headers.Authorization = `Bearer ${jwt}`;
    return headers;
}

async function refreshJwt(credentials) {
    const res = await fetch(`${API_BASE}/security/refresh-token`, {
        method: 'POST',
        headers: buildHeaders(credentials.device, credentials.instanceId, null),
        body: JSON.stringify({ device: credentials.device, refresh_token: credentials.refreshToken }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`refresh_token rejeté par Otaree (HTTP ${res.status}) : ${body.message || 'raison inconnue'}`);
    }
    const data = await res.json();
    return data.token;
}

// Filet de sécurité contre une vraie boucle infinie (hydra:next qui bouclerait sur lui-même,
// bug côté API...) — pas une limite métier. 100 pages = 3000 lots, choisi pour couvrir une
// région complète sans troncature (Normandie observée à 2496 lots réels) avec de la marge.
const MAX_PAGES = 100;

// Interroge estate/properties.jsonld et suit la pagination hydra:next jusqu'au bout (ou
// MAX_PAGES) — même logique que la boucle de inject.js. Retourne aussi `tronque: true` si la
// limite a été atteinte alors qu'il restait encore des résultats (hydra:next toujours
// présent) : le total réel excède alors ce qui a été rapporté, l'appelant doit le signaler
// plutôt que de laisser croire que la liste est complète.
async function paginerRecherche(jwt, credentials, filters) {
    const allLots = [];
    let currentUrl = `${API_BASE}/estate/properties.jsonld`;
    let currentPage = 1;
    let loopCount = 0;
    let next = null;

    while (currentUrl && loopCount < MAX_PAGES) {
        loopCount++;
        const res = await fetch(currentUrl, {
            method: 'POST',
            headers: buildHeaders(credentials.device, credentials.instanceId, jwt),
            body: JSON.stringify({ filters, page: currentPage, partial: true }),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(`Recherche Otaree refusée (HTTP ${res.status}) : ${body.message || 'raison inconnue'}`);
        }
        const data = await res.json();
        const members = data['hydra:member'] || [];
        allLots.push(...members);

        next = data['hydra:view'] && data['hydra:view']['hydra:next'];
        if (next) {
            currentUrl = API_BASE + next;
            const match = next.match(/page=(\d+)/);
            currentPage = match ? parseInt(match[1], 10) : currentPage + 1;
        } else {
            currentUrl = null;
        }
    }

    return { lots: allLots, tronque: loopCount >= MAX_PAGES && !!next };
}

// Credentials + JWT frais, avec erreurs typées (err.code) pour que la route HTTP renvoie un
// message clair plutôt qu'une erreur technique confuse — partagé entre recherche de lots et
// recherche de villes, mêmes deux cas d'échec possibles pour les deux.
// Exporté pour permettre à orchestrator.js de mutualiser un seul jeton sur tout un groupe de
// lots traités en parallèle (voir executerTraitement) — plutôt que d'en redemander un par lot,
// ce qui multiplierait les appels concurrents vers l'endpoint d'authentification (le seul point
// d'Otaree qui pourrait raisonnablement réagir mal à une rafale, même en l'absence de limite
// documentée).
export async function obtenirJwtFrais() {
    const credentials = await getOtareeCredentials();
    if (!credentials) {
        const err = new Error("Aucun accès Otaree connu — navigue sur Otaree avec l'extension active pour capturer un accès.");
        err.code = 'NO_CREDENTIALS';
        throw err;
    }

    try {
        const jwt = await refreshJwt(credentials);
        return { jwt, credentials };
    } catch (e) {
        const err = new Error('Session Otaree expirée — reconnecte-toi sur Otaree pour renouveler l\'accès.');
        err.code = 'REFRESH_FAILED';
        err.cause = e;
        throw err;
    }
}

// Point d'entrée principal : refresh -> recherche paginée -> { lots, tronque }.
export async function rechercherLotsOtaree(filters) {
    const { jwt, credentials } = await obtenirJwtFrais();
    return paginerRecherche(jwt, credentials, filters);
}

// Comptage rapide (avant de lancer une vraie recherche) : une seule page, pas de pagination
// complète — Otaree n'expose aucun total exact (pas de hydra:totalItems dans la réponse), donc
// un vrai compte pour une recherche large obligerait à tout paginer (potentiellement plusieurs
// minutes). Ici : nombre exact si tout tient sur la 1ère page, sinon minimum connu ("30+") avec
// approximatif: true — rapide et honnête plutôt que précis et lent.
export async function compterLotsOtaree(filters) {
    const { jwt, credentials } = await obtenirJwtFrais();
    const headers = buildHeaders(credentials.device, credentials.instanceId, jwt);
    const res = await fetch(`${API_BASE}/estate/properties.jsonld`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ filters, page: 1, partial: true }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`Recherche Otaree refusée (HTTP ${res.status}) : ${body.message || 'raison inconnue'}`);
    }
    const data = await res.json();
    const membres = data['hydra:member'] || [];
    const suite = !!(data['hydra:view'] && data['hydra:view']['hydra:next']);
    return { count: membres.length, approximatif: suite };
}

// Autocomplétion de ville (locations.json) — même mécanisme d'auth. `code` est directement
// réutilisable comme key/value dans le filtre `where` de rechercherLotsOtaree (format
// confirmé par capture réelle : `${type}_${id}`, ex. city_29781 pour Rouen).
export async function rechercherLocationsOtaree(q) {
    const { jwt, credentials } = await obtenirJwtFrais();

    const url = `${API_BASE}/locations.json?order[name]=asc&sortPriority=1&slug=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
        method: 'GET',
        headers: buildHeaders(credentials.device, credentials.instanceId, jwt, 'application/json'),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`Recherche de villes refusée (HTTP ${res.status}) : ${body.message || 'raison inconnue'}`);
    }
    const data = await res.json();
    return data.map((loc) => ({ id: loc.id, name: loc.name, type: loc.type, code: `${loc.type}_${loc.id}` }));
}

// Enrichit un lot brut (résultat de liste, sans images/documents) avec son détail et celui de
// son programme — même logique que extension-chrome/Otaree/inject.js (2 appels par lot).
// Nécessaire avant d'appeler /api/generate côté Ubiflow-Auto-API : buildTextContext/
// downloadOtareeImages attendent lot.images/lot.documents déjà peuplés, comme pour un lot
// venu de Downloads.
//
// Les 2 appels (détail du lot, détail du programme) sont indépendants l'un de l'autre — lancés
// en parallèle plutôt qu'en série (voir audit pipeline). Les résultats ne sont fusionnés dans
// `lot` qu'une fois les deux réponses connues, dans un ordre fixe (détail du lot d'abord, puis
// programme), pour ne pas dépendre de l'ordre d'arrivée des deux requêtes.
//
// `jetonPartage` optionnel ({jwt, credentials}) : permet à l'appelant de mutualiser un seul
// jeton Otaree sur tout un groupe de lots traités en parallèle (voir orchestrator.js,
// executerTraitement) plutôt que d'en redemander un par lot — évite une rafale de
// rafraîchissements de jeton simultanés. Si omis, comportement inchangé (jeton frais demandé ici).
export async function enrichirLot(lot, jetonPartage = null) {
    const { jwt, credentials } = jetonPartage || (await obtenirJwtFrais());
    const headers = buildHeaders(credentials.device, credentials.instanceId, jwt);

    const [detailRes, progRes] = await Promise.all([
        lot['@id'] ? fetch(`${API_BASE}${lot['@id']}`, { method: 'GET', headers }) : null,
        lot.program && lot.program['@id'] ? fetch(`${API_BASE}${lot.program['@id']}`, { method: 'GET', headers }) : null,
    ]);

    if (detailRes && detailRes.ok) {
        const detail = await detailRes.json();
        lot.documents = detail.documents || [];
        lot.images = detail.images || [];
        lot.plan = detail.plan || null;
    }

    if (progRes && progRes.ok) {
        const prog = await progRes.json();
        if (prog.documents?.length) lot.documents = (lot.documents || []).concat(prog.documents);
        if (prog.images?.length) lot.images = (lot.images || []).concat(prog.images);
        if (prog.perspective) lot.images = (lot.images || []).concat([prog.perspective]);
    }

    return lot;
}

// URL synthétique stable pour représenter une recherche server-side dans la table
// `recherches` (pas de vraie page de résultats puisqu'il n'y a pas de navigateur) — mêmes
// filtres -> même URL -> même recherche regroupée, peu importe l'ordre des clés reçues.
export function construireUrlRechercheOtaree(filters) {
    return `${SEARCH_PAGE_REFERER}?filters=${encodeURIComponent(stringifyTrie(filters))}`;
}

// Inverse de construireUrlRechercheOtaree — reconnaît une URL de recherche Otaree (par son
// préfixe stable) et en extrait les filtres d'origine, pour pouvoir relancer la même recherche
// (rescraping programmé des favorites, voir index.js) sans dépendre de l'ancien moteur mock. Une
// URL qui n'est pas de cette forme (vieille recherche pré-Otaree) renvoie null — l'appelant
// retombe alors sur le comportement existant.
export function parseFiltresOtareeDepuisUrl(url) {
    if (!url || !url.startsWith(SEARCH_PAGE_REFERER)) return null;
    try {
        const filtersRaw = new URL(url).searchParams.get('filters');
        return filtersRaw ? JSON.parse(filtersRaw) : null;
    } catch {
        return null;
    }
}

function stringifyTrie(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stringifyTrie).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stringifyTrie(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
