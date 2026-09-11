// Recherche Otaree directe, server-side, sans navigateur — utilise le refresh_token capturé
// par extension-chrome/Otaree/ (voir otareeTokenStore.js) pour s'auto-authentifier à la
// demande. Reproduit la logique de pagination/headers déjà éprouvée dans
// extension-chrome/Otaree/inject.js (fetch + suivi de hydra:view['hydra:next']), portée en
// Node — même comportement, pas de réinvention.
import { getOtareeCredentials, sauvegarderRefreshToken } from './otareeTokenStore.js';

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

    // Rotation confirmée en conditions réelles (2026-09-10) : chaque rafraîchissement renvoie un
    // NOUVEAU refresh_token — l'ancien code ne lisait que data.token (le JWT court terme) et
    // jetait silencieusement celui-ci, donc chaque appel suivant réutilisait un refresh_token de
    // plus en plus périmé. Sur un run de quelques minutes ça ne se voyait jamais ; sur un run de
    // plusieurs heures avec 20+ rafraîchissements (recherche nationale), ça a fini par être
    // rejeté par Otaree ("Session Otaree expirée"). En le persistant à chaque appel, le prochain
    // obtenirJwtFrais() (ici ou ailleurs, ex. l'extension Chrome) repart toujours du dernier
    // refresh_token réellement valide plutôt que du tout premier capturé.
    if (data.refresh_token && data.refresh_token !== credentials.refreshToken) {
        await sauvegarderRefreshToken(data.refresh_token, data.device || credentials.device, credentials.instanceId);
        // Mutation en place (credentials passé par référence) : si ce même objet sert à un 2e
        // rafraîchissement plus tard dans le même appel (ex. paginerRecherche sur une région très
        // longue), il repart déjà du token à jour sans attendre une relecture depuis la base.
        credentials.refreshToken = data.refresh_token;
    }

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
    let jetonActuel = jwt;

    while (currentUrl && loopCount < MAX_PAGES) {
        loopCount++;
        let res = await fetch(currentUrl, {
            method: 'POST',
            headers: buildHeaders(credentials.device, credentials.instanceId, jetonActuel),
            body: JSON.stringify({ filters, page: currentPage, partial: true }),
        });
        if (res.status === 401) {
            // Le JWT a une durée de vie courte et n'est demandé qu'une fois au début de la
            // pagination : sur une recherche large (ex. nationale, potentiellement des dizaines
            // de pages sur plusieurs minutes), il peut expirer en cours de route — constaté en
            // conditions réelles sur une recherche sans filtre de ville (HTTP 401 "Expired JWT
            // Token" après ~5 min). Séquentiel ici (pas de rafale concurrente comme dans
            // orchestrator.js), donc un simple rafraîchissement + re-tentative de la même page
            // suffit, sans mécanisme de retry plus élaboré.
            jetonActuel = await refreshJwt(credentials);
            res = await fetch(currentUrl, {
                method: 'POST',
                headers: buildHeaders(credentials.device, credentials.instanceId, jetonActuel),
                body: JSON.stringify({ filters, page: currentPage, partial: true }),
            });
        }
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

// Résout un nom de région/département en code Otaree (`region_X`/`department_X`) via
// l'autocomplétion (locations.json) — pas de liste d'ids codée en dur : les ids Otaree ne
// correspondent pas aux codes INSEE (constaté : Val-de-Marne = department_95, Hauts-de-Seine =
// department_93, alors que leurs codes INSEE réels sont 94/92), donc résoudre par nom exact à
// chaque appel évite de coder par erreur une zone géographique différente de celle voulue.
async function resoudreZone(nom, typeAttendu) {
    const resultats = await rechercherLocationsOtaree(nom);
    const trouve = resultats.find((r) => r.type === typeAttendu && r.name.toLowerCase() === nom.toLowerCase());
    if (!trouve) {
        throw new Error(`Zone Otaree introuvable : "${nom}" (type attendu : ${typeAttendu})`);
    }
    return trouve;
}

function whereDe(zone) {
    return [{ label: zone.name, key: zone.code, value: zone.code }];
}

// Recherche nationale "France entière" au sens propre du terme (filters.where vide/absent) :
// dépasse largement le plafond de pagination MAX_PAGES (~3000 lots) et peut faire tourner la
// recherche assez longtemps pour risquer une expiration de jeton en route (voir le
// rafraîchissement mid-pagination plus haut). Découpage en zones (voir zonesFrance.js) : chaque
// région est interrogée séparément ; si une région dépasse elle-même le plafond (`tronque:
// true`), repli automatique département par département à l'intérieur de cette seule région,
// plutôt que de découper systématiquement toute la France en 96 départements (inutilement lent
// pour les petites régions). `filtresBase` porte les filtres non géographiques (prix, typologie,
// etc.) — le `where` de zone est ajouté/remplacé à chaque appel.
//
// `onZoneLots(lots, zoneInfo)` est appelé pour CHAQUE sous-zone dès que ses lots sont prêts,
// plutôt que de renvoyer un seul tableau combiné à la fin — nécessaire après un plantage réel en
// "JavaScript heap out of memory" (Render, 2026-09-10) : une région dont plusieurs départements
// dépassent chacun le plafond (ex. Auvergne-Rhône-Alpes : Rhône, Isère, Savoie...) pouvait
// accumuler 10 000+ lots bruts en mémoire avant que l'appelant n'ait la moindre chance d'en
// importer/libérer un seul. Avec le callback, l'appelant importe et laisse chaque sous-zone
// partir au ramasse-miettes avant de passer à la suivante — jamais plus qu'une seule zone
// (~3000 lots max) en mémoire à la fois, comme la recherche nationale brute (sans découpage)
// qui n'avait jamais posé ce problème.
export async function rechercherZoneAvecRepli(nomRegion, departementsRegion, filtresBase = {}, onZoneLots = async () => {}) {
    const region = await resoudreZone(nomRegion, 'region');
    const { lots, tronque } = await rechercherLotsOtaree({ ...filtresBase, where: whereDe(region) });

    if (!tronque) {
        await onZoneLots(lots, { nom: nomRegion, type: 'region', nb: lots.length, tronque: false });
        return { zones: [{ nom: nomRegion, type: 'region', nb: lots.length, tronque: false }] };
    }

    const zones = [];
    for (const nomDept of departementsRegion) {
        const dept = await resoudreZone(nomDept, 'department');
        const resultat = await rechercherLotsOtaree({ ...filtresBase, where: whereDe(dept) });
        await onZoneLots(resultat.lots, { nom: nomDept, type: 'department', nb: resultat.lots.length, tronque: resultat.tronque });
        zones.push({ nom: nomDept, type: 'department', nb: resultat.lots.length, tronque: resultat.tronque });
    }
    return { zones };
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
//
// Retry avec backoff + logging explicite ajoutés après constat en conditions réelles (recherche
// Bordeaux, 110 lots) : 104/110 lots publiés sans aucune photo, alors qu'Otaree en fournit
// normalement — les 6 seuls succès étaient tous regroupés dans les 90 premières secondes d'un run
// de 160s, coupure nette ensuite, jamais un seul succès isolé après. Signature d'une limite de
// débit côté Otaree sur cet endpoint précis, pas une expiration de jeton (un jeton frais est déjà
// redemandé à chaque groupe de 4 lots, voir orchestrator.js). Avant ce correctif, un `!res.ok`
// silencieux ici laissait `lot.images`/`lot.documents` vides sans qu'aucune trace n'apparaisse
// nulle part (aucun throw, aucun log) — le pipeline en aval continuait normalement en pensant que
// le lot n'avait simplement pas de photo. Seuls documents/images/plan viennent de cet appel de
// détail — catégorie de résidence, promoteur, prix/loyer sont déjà complets dans le résultat de
// liste (voir commentaire au-dessus) et ne sont donc jamais affectés par cette panne précise.
const MAX_TENTATIVES_DETAIL_OTAREE = 3;
// Aligné sur les autres appels du pipeline (ex: axios timeout 60s côté OpenAI, mais ceux-ci sont
// de simples GET censés répondre en moins d'une seconde en temps normal) — sans ce timeout, une
// tentative qui traîne (constaté jusqu'à 80s en conditions réelles sous rate-limit Otaree) combinée
// aux 3 tentatives de retry pouvait faire durer un seul enrichirLot plusieurs minutes.
const TIMEOUT_DETAIL_OTAREE_MS = 18000;

async function fetchAvecRetry(url, headers, contexte) {
    let derniereReponse = null;
    for (let tentative = 1; tentative <= MAX_TENTATIVES_DETAIL_OTAREE; tentative++) {
        let res;
        try {
            res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_DETAIL_OTAREE_MS) });
        } catch (e) {
            const raison = e.name === 'TimeoutError' ? `timeout après ${TIMEOUT_DETAIL_OTAREE_MS}ms` : e.message;
            console.error(`[enrichirLot] erreur réseau (${contexte}) tentative ${tentative}/${MAX_TENTATIVES_DETAIL_OTAREE} : ${raison} — ${new Date().toISOString()}`);
            if (tentative === MAX_TENTATIVES_DETAIL_OTAREE) return null;
            await new Promise((r) => setTimeout(r, 1000 * 2 ** (tentative - 1)));
            continue;
        }
        if (res.ok) return res;
        derniereReponse = res;
        if (tentative === MAX_TENTATIVES_DETAIL_OTAREE) {
            console.error(`[enrichirLot] échec définitif après ${MAX_TENTATIVES_DETAIL_OTAREE} tentatives (${contexte}) : HTTP ${res.status} — ${new Date().toISOString()}`);
            return res;
        }
        console.error(`[enrichirLot] HTTP ${res.status} (${contexte}) tentative ${tentative}/${MAX_TENTATIVES_DETAIL_OTAREE} — nouvelle tentative dans ${1000 * 2 ** (tentative - 1)}ms`);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (tentative - 1)));
    }
    return derniereReponse;
}

export async function enrichirLot(lot, jetonPartage = null) {
    const { jwt, credentials } = jetonPartage || (await obtenirJwtFrais());
    const headers = buildHeaders(credentials.device, credentials.instanceId, jwt);
    const idLot = lot.id ?? lot['@id'] ?? '?';

    const [detailRes, progRes] = await Promise.all([
        lot['@id'] ? fetchAvecRetry(`${API_BASE}${lot['@id']}`, headers, `détail lot ${idLot}`) : null,
        lot.program && lot.program['@id'] ? fetchAvecRetry(`${API_BASE}${lot.program['@id']}`, headers, `détail programme du lot ${idLot}`) : null,
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

// Vérifie si un lot existe toujours côté Otaree via son atId (ex: "/properties/xxx", déjà
// stocké tel quel dans annonces.raw_data['@id'] à l'import — voir mapLotOtareeVersAnnonce,
// orchestrator.js). Distingue explicitement 3 cas plutôt que juste ok/pas-ok — 'inconnu' pour
// toute erreur réseau/timeout/5xx : voir verifierDisparitionConfirmee, JAMAIS interprété comme
// une disparition (contrairement à fetchAvecRetry, qui traite tout échec pareil et est pensé
// pour enrichir des lots déjà supposés vivants, pas pour trancher s'ils le sont encore).
export async function verifierExistenceLot(atId, timeoutMs = TIMEOUT_DETAIL_OTAREE_MS) {
    try {
        const { jwt, credentials } = await obtenirJwtFrais();
        const headers = buildHeaders(credentials.device, credentials.instanceId, jwt);
        const res = await fetch(`${API_BASE}${atId}`, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 404) return 'absent';
        if (res.ok) return 'existe';
        console.error(`[verifierExistenceLot] statut HTTP inattendu ${res.status} pour ${atId} — traité comme 'inconnu'.`);
        return 'inconnu';
    } catch (e) {
        const raison = e.name === 'TimeoutError' ? `timeout après ${timeoutMs}ms` : e.message;
        console.error(`[verifierExistenceLot] erreur réseau pour ${atId} : ${raison} — traité comme 'inconnu'.`);
        return 'inconnu';
    }
}

// Confirme une disparition par 2 vérifications espacées avant de conclure (éviter un faux
// positif transitoire côté Otaree — indisponibilité ponctuelle, lot momentanément dépublié puis
// republié...). Ne conclut JAMAIS à une disparition sur un seul 404, ni sur un statut 'inconnu'
// à quelque étape que ce soit — dans le doute, on ne supprime rien, on retentera la prochaine
// nuit (voir syncDisparitions.js).
const DELAI_ENTRE_VERIFICATIONS_MS = 5 * 60 * 1000;

export async function verifierDisparitionConfirmee(atId, delaiMs = DELAI_ENTRE_VERIFICATIONS_MS) {
    const premiere = await verifierExistenceLot(atId);
    if (premiere !== 'absent') return { disparitionConfirmee: false, statut: premiere };

    await new Promise((r) => setTimeout(r, delaiMs));

    const seconde = await verifierExistenceLot(atId);
    if (seconde !== 'absent') return { disparitionConfirmee: false, statut: seconde };

    return { disparitionConfirmee: true, statut: 'absent' };
}

// URL synthétique stable pour représenter une recherche server-side dans la table
// `recherches` (pas de vraie page de résultats puisqu'il n'y a pas de navigateur) — mêmes
// filtres -> même URL -> même recherche regroupée, peu importe l'ordre des clés reçues.
export function construireUrlRechercheOtaree(filters) {
    return `${SEARCH_PAGE_REFERER}?filters=${encodeURIComponent(stringifyTrie(filters))}`;
}

// URL synthétique stable pour la recherche "France entière" (voir rechercherZoneAvecRepli /
// zonesFrance.js) — toujours la même valeur, pour que les lancements successifs se regroupent
// dans la même ligne `recherches` (comme une recherche normale re-scrapée). Limite connue : le
// rescraping programmé des favoris (rescraperRechercheFavorite, orchestrator.js) ne reconnaît
// pas encore ce format — parseFiltresOtareeDepuisUrl renverra null dessus et l'appelant
// retombera sur l'ancien moteur de scraping HTML, qui échouera proprement (erreur consignée,
// pas de crash) plutôt que de relancer la recherche nationale. À corriger séparément si le
// rescraping automatique d'un favori national est nécessaire.
export function construireUrlRechercheNationale() {
    return `${SEARCH_PAGE_REFERER}?filters=national`;
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
