require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { db, initDb } = require('./db.js');
const { estLotLmnp } = require('./dispositifFiscal.js');

// Filet de sécurité pour le diagnostic en hébergement distant — voir le commentaire équivalent
// dans dashboard/server/src/index.js.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

initDb().catch((err) => console.error('[initDb] échec :', err));

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const DEFAULT_ESPACE_LOGIN = "ag762216";
let currentEspaceLogin = DEFAULT_ESPACE_LOGIN;

async function resoudreTokenPourEspace(espaceLogin) {
    const row = await db.prepare(`SELECT token FROM hubiflow_tokens WHERE espace_login = ?`).get(espaceLogin);
    if (!row) {
        return { erreur: `Aucun token connu pour l'espace ${espaceLogin} — connecte-toi dessus au moins une fois dans Chrome.` };
    }
    const token = row.token;
    const exp = decoderExpirationJWT(token);
    if (exp && Date.now() > exp) {
        const expireDepuisMin = Math.round((Date.now() - exp) / 60000);
        return {
            erreur: `Token pour l'espace ${espaceLogin} expiré depuis ${expireDepuisMin} min — reconnecte-toi sur cet espace dans Chrome.`
        };
    }
    return { token };
}

function decoderExpirationJWT(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return payload.exp ? payload.exp * 1000 : null; // en ms
    } catch (e) {
        return null;
    }
}

const AGENCE_CONFIG = {
    contact_email: "cgalliot@plusimmo76.fr",
    contact_phone: "02 32 86 47 72",
    contact_address: "49 RUE JEANNE D ARC",
    contact_cp: "76000",
    contact_city: "ROUEN",
    flux_code: "SAISIE_IMMO"
};

app.post('/api/token', async (req, res) => {
    try {
        const { token, espaceLogin } = req.body;
        if (token) {
            const login = espaceLogin || DEFAULT_ESPACE_LOGIN;
            await db.prepare(
                `INSERT INTO hubiflow_tokens (espace_login, token, date) 
                 VALUES (?, ?, CURRENT_TIMESTAMP) 
                 ON CONFLICT (espace_login) DO UPDATE SET token = EXCLUDED.token, date = CURRENT_TIMESTAMP`
            ).run(login, token);
            currentEspaceLogin = login;
            console.log(`[🔑] Nouveau token Ubiflow intercepté (espace : ${login})`);
            res.json({ success: true, message: 'Token sauvegardé', espaceLogin: login });
        } else {
            res.status(400).json({ success: false, message: 'Token manquant' });
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: e.message });
    }
});

async function envoyerAUbiflow(payload, token, espaceLogin) {
    try {
        console.log(`[🌐] Envoi de l'annonce à l'espace ${espaceLogin}...`);
        const response = await axios.post(
            'https://espace-client-backend.ubiflow.net/traitement-envoi-annonce-advanced?lang=fr',
            payload,
            {
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Content-Type': 'application/json;charset=UTF-8',
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        if (response.data && response.data.type === 'success') {
            return {
                statusCode: 200,
                body: {
                    success: true,
                    adId: response.data.ad.id,
                    linkEdit: `https://espace-client.ubiflow.net/posts/edit/${response.data.ad.id}`,
                    linkView: `https://espace-client.ubiflow.net/posts/${response.data.ad.id}`
                }
            };
        }
        return { statusCode: 400, body: { success: false, error: 'Erreur retournée par Ubiflow', details: response.data } };
    } catch (error) {
        let errorMsg = error.message;
        let details = null;
        if (error.response) {
            details = error.response.data;
        }
        return { statusCode: error.response ? error.response.status : 500, body: { success: false, error: errorMsg, details } };
    }
}

app.post('/api/publish', async (req, res) => {
    try {
        const { textContext, base64Images, villeConnue, codePostalConnu } = req.body;
        const resolu = await resoudreTokenPourEspace(currentEspaceLogin);
        if (resolu.erreur) {
            return res.status(401).json({ success: false, error: resolu.erreur });
        }

        const aiData = await callOpenAI(textContext, base64Images || []);
        const payload = buildUbiflowPayload(aiData, base64Images || [], { ville: villeConnue, codePostal: codePostalConnu }, currentEspaceLogin);

        const { statusCode, body } = await envoyerAUbiflow(payload, resolu.token, currentEspaceLogin);
        res.status(statusCode).json(body);
    } catch (error) {
        let errorMsg = error.message;
        let details = null;
        if (error.response) {
            details = error.response.data;
        }
        res.status(error.response ? error.response.status : 500).json({ success: false, error: errorMsg, details });
    }
});

async function activerAnnonceHubiflow(adId, token, espaceLogin) {
    const adIdPropre = parseInt(adId, 10);
    const annonceurId = parseInt(String(espaceLogin).replace(/\D/g, ''), 10);
    try {
        await axios.patch(
            `https://espace-client-backend.ubiflow.net/annonce/${adIdPropre}`,
            {
                annonceur: { id: annonceurId },
                flux: { code: AGENCE_CONFIG.flux_code },
                annonce: { STATUS: "A" }
            },
            {
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Content-Type': 'application/json;charset=UTF-8',
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        return { success: true };
    } catch (error) {
        let errorMsg = error.message;
        if (error.response) errorMsg += ' - ' + JSON.stringify(error.response.data).substring(0, 300);
        return { success: false, error: errorMsg };
    }
}

async function supprimerAnnonceHubiflow(adId, token, espaceLogin) {
    const adIdPropre = parseInt(adId, 10);
    try {
        await axios.delete(
            `https://espace-client-backend.ubiflow.net/annonce/${adIdPropre}?lang=fr`,
            {
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        return { success: true };
    } catch (error) {
        let errorMsg = error.message;
        if (error.response) errorMsg += ' - ' + JSON.stringify(error.response.data).substring(0, 300);
        return { success: false, error: errorMsg };
    }
}

app.post('/api/annonce/:id/depublier', async (req, res) => {
    const { espaceLoginAttendu } = req.body;
    if (!espaceLoginAttendu) return res.status(400).json({ success: false, error: 'espaceLoginAttendu requis' });
    const resolu = await resoudreTokenPourEspace(espaceLoginAttendu);
    if (resolu.erreur) return res.status(401).json({ success: false, error: resolu.erreur });
    
    const result = await supprimerAnnonceHubiflow(req.params.id, resolu.token, espaceLoginAttendu);
    res.status(result.success ? 200 : 502).json(result);
});

async function lireEtatAnnonceHubiflow(adId, token) {
    const adIdPropre = parseInt(adId, 10);
    try {
        const response = await axios.get(
            `https://espace-client-backend.ubiflow.net/annonce/${adIdPropre}?lang=fr`,
            {
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        return { success: true, etat: response.data.etat, etatAnnonce: response.data.etatAnnonce };
    } catch (error) {
        let errorMsg = error.message;
        if (error.response) errorMsg += ' - ' + JSON.stringify(error.response.data).substring(0, 300);
        return { success: false, error: errorMsg };
    }
}

app.get('/api/annonce/:id/etat', async (req, res) => {
    const { espaceLoginAttendu } = req.query;
    if (!espaceLoginAttendu) return res.status(400).json({ success: false, error: 'espaceLoginAttendu requis' });
    const resolu = await resoudreTokenPourEspace(espaceLoginAttendu);
    if (resolu.erreur) return res.status(401).json({ success: false, error: resolu.erreur });

    const result = await lireEtatAnnonceHubiflow(req.params.id, resolu.token);
    res.status(result.success ? 200 : 502).json(result);
});

// Recherche libre Hubiflow — sert au dédup "avertissement" avant publication (dashboard/,
// bouton explicite "Vérifier les doublons", jamais automatique). Deux appels (etat=A actif +
// etat=B brouillon) car `etat` est obligatoire côté Hubiflow et ne couvre qu'un seul statut à la
// fois — une annonce jamais activée (brouillon) serait invisible avec etat=A seul, cas réel
// rencontré en le vérifiant. Paramètre rechercheLibre confirmé par capture réseau réelle (pas
// "search", qui ne filtre rien). Lecture seule, aucun effet de bord.
async function rechercherAnnoncesParVille(espaceLoginAttendu, ville) {
    const resolu = await resoudreTokenPourEspace(espaceLoginAttendu);
    if (resolu.erreur) return { success: false, error: resolu.erreur };

    const items = [];
    for (const etat of ['A', 'B']) {
        try {
            const url = `https://espace-client-backend.ubiflow.net/annonce?champsRechercheLibre[]=ville&champsRechercheLibre[]=titre&champsRechercheLibre[]=reference&rechercheLibre=${encodeURIComponent(ville)}&etat=${etat}&page=1&perPage=20&orderBy=-DC&advanced=false&lang=fr`;
            const response = await axios.get(url, {
                headers: { 'Accept': 'application/json, text/plain, */*', 'Authorization': `Bearer ${resolu.token}` },
            });
            items.push(...(response.data?._embedded?.annonce || []));
        } catch (error) {
            console.error(`[doublons] échec recherche Hubiflow (etat=${etat}, ville=${ville}) :`, error.message);
        }
    }
    return {
        success: true,
        annonces: items.map((a) => ({
            id: a.id,
            reference: a.reference,
            titre: a.titre,
            prix: a.prix,
            etat: a.etat,
            ville: a.donnees?.ville?.valeur || null,
            lien: `https://espace-client.ubiflow.net/posts/edit/${a.id}`,
        })),
    };
}

app.get('/api/rechercher-doublons-hubiflow', async (req, res) => {
    const { espaceLoginAttendu, ville } = req.query;
    if (!espaceLoginAttendu || !ville) {
        return res.status(400).json({ success: false, error: 'espaceLoginAttendu et ville requis' });
    }
    const result = await rechercherAnnoncesParVille(espaceLoginAttendu, ville);
    res.status(result.success ? 200 : 401).json(result);
});

app.post('/api/publish-payload', async (req, res) => {
    const { aiData, base64Images, villeConnue, codePostalConnu, prixConnu, espaceLoginAttendu, mode } = req.body;

    if (!espaceLoginAttendu) return res.status(400).json({ success: false, error: 'espaceLoginAttendu requis' });
    if (!aiData) return res.status(400).json({ success: false, error: 'aiData manquant' });

    const resolu = await resoudreTokenPourEspace(espaceLoginAttendu);
    if (resolu.erreur) return res.status(401).json({ success: false, error: resolu.erreur });

    const payload = buildUbiflowPayload(aiData, base64Images || [], { ville: villeConnue, codePostal: codePostalConnu, prix: prixConnu }, espaceLoginAttendu);
    const { statusCode, body } = await envoyerAUbiflow(payload, resolu.token, espaceLoginAttendu);

    if (statusCode === 200 && body.success && mode === 'actif') {
        const activation = await activerAnnonceHubiflow(body.adId, resolu.token, espaceLoginAttendu);
        if (activation.success) {
            return res.status(200).json({ ...body, actif: true });
        }
        return res.status(200).json({ ...body, actif: false, erreurActivation: activation.error });
    }

    res.status(statusCode).json(body);
});

async function downloadOtareeImages(lot, imagesSelection) {
    const images = Array.isArray(lot.images) ? lot.images : [];
    if (images.length === 0) return [];

    // Sélection manuelle faite sur l'écran de confirmation (voir ScraperControl.jsx) — par
    // `name`, seul identifiant à peu près stable entre l'aperçu (/lot-detail, un premier
    // enrichirLot) et cet appel (un second enrichirLot, indépendant, refait ici). Si le nom
    // choisi n'existe plus dans ce second fetch, silencieusement ignoré : retombe sur le tri
    // par défaut plutôt que de planter la génération pour ça.
    const exclues = new Set((imagesSelection?.exclues || []).map((n) => (n || '').toLowerCase()));
    const premiere = (imagesSelection?.premiere || '').toLowerCase() || null;

    const sorted = [...images]
        .filter((img) => !exclues.has((img.name || '').toLowerCase()))
        .sort((a, b) => {
            const an = (a.name || '').toLowerCase();
            const bn = (b.name || '').toLowerCase();
            if (premiere) {
                if (an === premiere && bn !== premiere) return -1;
                if (bn === premiere && an !== premiere) return 1;
            }
            const aExt = an.includes('perspective') || an.includes('exterieur');
            const bExt = bn.includes('perspective') || bn.includes('exterieur');
            if (aExt && !bExt) return -1;
            if (!aExt && bExt) return 1;
            return an.localeCompare(bn);
        });

    const result = [];
    const seenHashes = new Set();
    for (const img of sorted) {
        if (result.length >= 20) break;
        // Otaree mélange parfois des documents (plans PDF...) dans le même tableau que les photos ;
        // mimeType est fiable pour les exclure (contrairement au content-type CloudFront de l'URL, lui erroné).
        if (img.mimeType && !img.mimeType.startsWith('image/')) continue;
        const url = img.urls && (img.urls.large || img.urls.medium || img.urls.medium_fit || img.urls.small);
        if (!url) continue;
        let buf = null;
        for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
            try {
                const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
                buf = Buffer.from(resp.data);
            } catch (e) {
                if (attempt !== 3) await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
        if (!buf) continue;

        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);
        const b64 = buf.toString('base64');
        const mime = (img.mimeType && img.mimeType.startsWith('image/')) ? img.mimeType : 'image/jpeg';
        result.push({ name: (img.name || 'image').toLowerCase(), data: `data:${mime};base64,${b64}` });
    }
    return result;
}

const TEXT_CONTEXT_MAX_CHARS = 60000;
function buildTextContext(lot) {
    const allege = { ...lot };
    if (Array.isArray(allege.images)) {
        allege.images = allege.images.map(img => ({ name: img.name, mimeType: img.mimeType }));
    }
    if (Array.isArray(allege.documents)) {
        allege.documents = allege.documents.map(doc => ({ type: doc.type, name: doc.file?.name || doc.name || null }));
    }
    let text = JSON.stringify(allege, null, 2);
    if (text.length > TEXT_CONTEXT_MAX_CHARS) {
        text = text.slice(0, TEXT_CONTEXT_MAX_CHARS) + '\n... (contenu tronqué, trop volumineux)';
    }
    return text;
}

// "T3" -> 3, "Studio" -> 1 — même convention que TYPOLOGY_OPTIONS côté dashboard
// (ScraperControl.jsx). Renvoie null si non reconnaissable, jamais une valeur devinée.
function piecesDepuisTypologie(typology) {
    if (!typology) return null;
    const t = String(typology).toUpperCase();
    if (t === 'STUDIO') return 1;
    const m = t.match(/^T(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
}

// Champs structurés qu'on connaît déjà avec certitude depuis les données Otaree du lot — jamais
// à faire deviner par l'IA (voir callOpenAILmnp, qui ne génère plus que titre+texte pour les lots
// LMNP). Mêmes clés que le schéma JSON historique, pour ne rien changer à buildUbiflowPayload en
// aval : seule la SOURCE de ces valeurs change (code plutôt qu'IA), pas leur format.
function champsConnusDepuisLot(lot) {
    const champs = {};
    if (typeof lot.surface === 'number') champs.surface = String(lot.surface);

    const pieces = piecesDepuisTypologie(lot.typology);
    if (pieces !== null) champs.pieces = String(pieces);

    if (typeof lot.floor === 'number') champs.etage = String(lot.floor);

    if (Array.isArray(lot.annexesSurfaces)) {
        const balcons = lot.annexesSurfaces.filter((a) => a.type === 'BALCON' || a.type === 'TERRASSE');
        if (balcons.length > 0) {
            champs.balcon = true;
            champs.nb_balcons = String(balcons.length);
            if (typeof balcons[0].surface === 'number') champs.surface_balcon = String(balcons[0].surface);
        } else if (Array.isArray(lot.annexes)) {
            champs.balcon = false;
        }
    }

    if (typeof lot.parkingCount === 'number') {
        champs.parking = lot.parkingCount > 0;
        champs.nb_parkings = String(lot.parkingCount);
    }

    if (Array.isArray(lot.exposures) && lot.exposures.length > 0) {
        champs.exposition = lot.exposures.join('').toLowerCase();
    }

    // energyClass est une lettre (A-G) quand elle est connue — jamais une consommation chiffrée
    // (qu'on n'a pas) : on ne remplit dpe_conso/dpe_ges que si la lettre est réellement présente,
    // jamais une valeur par défaut.
    if (typeof lot.energyClass === 'string' && lot.energyClass) {
        champs.dpe_conso = lot.energyClass;
    }

    return champs;
}

// Rentabilité Otaree (prices[0].profitability) vérifiée empiriquement (838 lots LMNP en base,
// 2026-08-30) : correspond exactement à loyer HT x12 / prix HT UNIQUEMENT quand vatRate === 0
// (635/635 lots, écart nul). Dès que la TVA entre en jeu (vatRate 20 ou -1/inconnu), la méthode
// réelle d'Otaree diverge de façon incohérente (115/203 seulement) — jamais assez fiable pour
// être affichée. Ne jamais l'utiliser hors de ce cas précis, et ne jamais recalculer nous-mêmes
// une alternative non vérifiée : conforme à la consigne "ne jamais afficher un chiffre dont on
// n'est pas sûr qu'il suit la bonne méthode".
function donneesFinancieresFiablesDepuisLot(lot) {
    const p = lot.prices?.[0];
    if (!p) return null;
    const donnees = {};
    if (typeof p.price === 'number') donnees.prix = p.price;

    if (typeof p.price === 'number' && p.price > 0 && typeof p.monthlyRent === 'number') {
        const rendementImplicite = (p.monthlyRent * 12 / p.price) * 100;
        // Garde-fou anti-donnée aberrante : constaté sur un vrai lot Otaree en test (loyer mensuel
        // sans rapport plausible avec le prix, ~50% de rendement implicite) — une erreur dans la
        // donnée source elle-même, pas une invention de l'IA, mais jamais à transmettre comme
        // "connue avec certitude" si le rendement qu'elle impliquerait est hors de toute
        // plausibilité pour du LMNP géré (typiquement 2 à 7%, marge large jusqu'à 15%).
        if (rendementImplicite >= 1 && rendementImplicite <= 15) {
            donnees.loyerMensuel = p.monthlyRent;
            if (p.vatRate === 0 && typeof p.profitability === 'number') donnees.rentabilite = p.profitability;
        }
    }
    return Object.keys(donnees).length > 0 ? donnees : null;
}

const PROMPT_SYSTEME_LMNP_V2 = `Tu es le rédacteur immobilier de La Centrale du LMNP, spécialiste de la commercialisation de biens immobiliers destinés à l'investissement en LMNP géré en résidences de services.

Les annonces sont destinées au grand public et diffusées principalement sur des portails immobiliers tels que Leboncoin et SeLoger.

Les biens proposés appartiennent à cinq catégories distinctes : Résidences étudiantes, Résidences services seniors, EHPAD, Résidences de tourisme, Résidences affaires.

RÈGLE ABSOLUE : NE JAMAIS INVENTER UNE INFORMATION. Ne jamais extrapoler une information absente. Ne jamais transformer une hypothèse en fait. Ne jamais compléter une information manquante en utilisant une connaissance générale supposée de la résidence, de l'exploitant ou de la ville. Lorsqu'une information est absente, incertaine ou contradictoire, privilégie son omission.

=== DONNÉES RÉELLEMENT DISPONIBLES DANS CE PIPELINE (à lire avant toute chose) ===

Contrairement à un dossier commercialisation complet, tu ne reçois JAMAIS ici : le bail commercial et ses annexes, des brochures ou plaquettes, des diagnostics, des documents officiels sur l'exploitant, ou des données financières détaillées (charges de copropriété, taxe foncière). Ces sources n'existent pas dans ce pipeline — n'y fais jamais référence comme si tu les avais consultées, et ne comble jamais leur absence par une supposition.

Tu reçois uniquement : les données structurées du lot Otaree (JSON ci-dessous), des photos, et éventuellement un descriptif partenaire s'il existe dans ces données.

IDENTITÉ DE L'EXPLOITANT — VIGILANCE PARTICULIÈRE : le champ "developer" des données Otaree est le PROMOTEUR (celui qui a construit/vendu le programme), jamais l'exploitant (le gestionnaire qui exploite au quotidien la résidence et verse le loyer). Ces deux identités sont très souvent différentes. Ne cite JAMAIS de nom d'exploitant, ni ne le déduis du nom du promoteur, sauf s'il apparaît explicitement et sans ambiguïté dans un texte descriptif fourni. En l'absence de cette information (le cas normal ici), reste générique : "un exploitant professionnel", "le gestionnaire de la résidence", sans jamais inventer de nom. Pour la même raison, le paragraphe spécifique "POURQUOI INVESTIR CHEZ CENTER PARCS ?" ne doit être inséré QUE si le nom "Center Parcs" apparaît explicitement et sans ambiguïté dans les données fournies — jamais par déduction.

DONNÉES FINANCIÈRES FIABLES : quand elles te sont fournies explicitement dans un bloc "DONNÉES CONNUES AVEC CERTITUDE" du message utilisateur, utilise EXCLUSIVEMENT ces valeurs pour prix/loyer/rentabilité — ne recalcule jamais une rentabilité toi-même, et si aucune rentabilité fiable n'est fournie dans ce bloc, omets simplement la ligne correspondante dans les chiffres clés (ne jamais écrire "non communiquée").

=== PRINCIPE FONDAMENTAL : ANALYSER AVANT DE RÉDIGER ===

Avant de rédiger l'annonce, analyse l'intégralité des informations disponibles afin d'établir une fiche fiable du bien. Cette analyse est une étape interne, elle ne doit pas apparaître dans l'annonce finale. Identifie : la catégorie exacte de résidence, le type de logement, la surface, les annexes, le prix, le loyer, la rentabilité si fournie, les caractéristiques de la résidence, les services, l'emplacement, les points d'intérêt, les arguments commerciaux réellement différenciants. Ne cherche pas à utiliser toutes les informations disponibles — identifie les plus utiles.

=== HIÉRARCHIE ET FIABILITÉ DES SOURCES ===

Pour les informations contractuelles, privilégie toujours les documents contractuels (absents ici, donc omets toute affirmation contractuelle spécifique à ce bien au-delà du fonctionnement général du LMNP géré). En cas de contradiction entre plusieurs sources, utilise la plus fiable. Si le doute subsiste, n'utilise pas l'information.

=== TITRE ===

Titre court, attractif, concret, factuel. Doit obligatoirement comporter "LMNP géré" (tourisme/étudiant) ou "LMNP" (senior/EHPAD/affaires). Précise la catégorie quand cela améliore la compréhension (LMNP géré Tourisme, LMNP géré Étudiant, LMNP Senior, LMNP EHPAD, LMNP Affaires). Met en avant 1-2 caractéristiques réellement différenciantes du bien ou de la résidence. Ne répète pas commune/prix/surface/nombre de pièces si déjà affichés par le portail. Hiérarchie : 1) caractéristique exceptionnelle du bien/résidence, 2) emplacement attractif, 3) avantage contractuel spécifique (si documenté), 4) occupation personnelle (uniquement si explicitement documentée — jamais ici en pratique), 5) rendement si notable (>= 6,5%, et uniquement si la rentabilité fournie est fiable). Évite superlatifs non justifiés, majuscules inutiles, promesses de sécurité absolue, formulations génériques.

CONTRAINTE DE LONGUEUR STRICTE : le titre DOIT faire entre 55 et 60 caractères (espaces compris), jamais moins, jamais plus. Compte précisément les caractères avant de répondre. Un titre trop court (ex: "LMNP géré Étudiant à Mulhouse avec parking", 42 caractères) est un titre à corriger : ajoute un détail différenciant supplémentaire et réel (nom de résidence, ville, caractéristique confirmée) jusqu'à atteindre la fourchette exigée, sans jamais inventer un élément absent des données. Si tu ne peux pas atteindre 55 caractères sans inventer, complète avec la ville ou le type de logement, déjà connus avec certitude.

=== LONGUEUR ET STYLE DU DESCRIPTIF ===

Minimum 500 caractères. Cible : environ 1500 à 2200 caractères espaces compris. Cette longueur est une cible, pas une obligation absolue — ne jamais allonger artificiellement, ne jamais produire une annonce excessivement courte si le dossier contient des informations importantes. Style : clair, professionnel, pédagogique, commercial sans excès, fluide, crédible, accessible au grand public, orienté investisseur. Utilise des listes pour les chiffres clés. Évite jargon CGP, formulations administratives, répétitions, superlatifs, slogans génériques. Facile à parcourir sur smartphone.

=== STRUCTURE OBLIGATOIRE (5 BLOCS) ===

BLOC 1 — COMPRENDRE IMMÉDIATEMENT LE LMNP GÉRÉ : introduction courte expliquant qu'il s'agit d'un investissement locatif en LMNP géré sous bail commercial — exploitation confiée à un gestionnaire professionnel (l'exploitant, locataire du bien), pas de gestion locative quotidienne ni de travaux courants pour le propriétaire, loyer versé selon les conditions du bail que le bien soit libre ou occupé, intérêt fiscal potentiel du statut LMNP et de l'amortissement (selon situation de l'investisseur et réglementation applicable). Explique tôt la contrainte principale : le propriétaire ne peut pas habiter librement le logement ni y loger un proche pendant l'exécution du bail commercial — formule cela de façon pédagogique, jamais agressive (jamais "INUTILE DE NOUS CONTACTER POUR Y HABITER"). Comme aucune donnée de bail n'est disponible dans ce dossier, n'affirme jamais qu'une occupation personnelle est prévue — reste sur la règle générale.

BLOC 2 — LES CHIFFRES CLÉS : intertitre "LES CHIFFRES CLÉS" en majuscules sur sa propre ligne, puis une donnée par ligne au format "Libellé : valeur", en n'utilisant QUE les données fournies dans le bloc "DONNÉES CONNUES AVEC CERTITUDE" du message utilisateur (prix, loyer annuel = loyer mensuel x12, rentabilité si fournie). N'affiche jamais une ligne "charges de copropriété", "taxe foncière", "gestion locative", "travaux courants" ou toute autre donnée non explicitement fournie — omets la ligne plutôt que d'écrire "non communiqué(e)". Ne jamais indiquer durée restante du bail, date de renouvellement, fonds travaux, ou effort d'épargne mensuel.

BLOC 3 — POURQUOI CETTE CATÉGORIE ? : intertitre "POURQUOI INVESTIR DANS [TYPE DE RÉSIDENCE] ?" en majuscules, 2 à 4 lignes contextualisant l'investissement selon la catégorie identifiée (utilise les statistiques de marché ci-dessous UNIQUEMENT si elles sont pertinentes pour la catégorie identifiée, jamais inventées) :
- Résidence étudiante : plus de 3 millions d'étudiants pour 400 000 places en résidence étudiante, soit une place pour huit étudiants.
- Résidence services seniors : 22% de la population française a plus de 65 ans aujourd'hui, près de 40% d'ici 15 ans. Une résidence services seniors n'est PAS un EHPAD — jamais de vocabulaire médicalisé si ce n'est pas le cas.
- EHPAD : 1,6 million de personnes de plus de 85 ans aujourd'hui, près de 5 millions en 2050. Environ 92 places en EHPAD pour 1000 personnes de plus de 75 ans ; dans certaines zones, 50 à 100 demandes pour une seule place. Ne jamais présenter un EHPAD comme une résidence services seniors.
- Résidence de tourisme : la France, première puissance touristique mondiale, plus de 100 millions de visiteurs étrangers par an (7% de la richesse nationale, 2 millions d'emplois). Si l'exploitant "Center Parcs" est explicitement identifié (jamais déduit), insère le paragraphe dédié (voir plus haut).
- Résidence affaires : mets en avant clientèle professionnelle, centre-ville, quartier d'affaires, proximité gare/aéroport/métro/tramway UNIQUEMENT si confirmés par les données du lot.

BLOC 4 — LE BIEN ET LA RÉSIDENCE : intertitre "LE BIEN ET LA RÉSIDENCE" en majuscules. Réécris dans un langage naturel (ne recopie jamais mécaniquement un descriptif partenaire). Sélectionne 3 à 6 caractéristiques réellement différenciantes parmi celles confirmées par les données (emplacement, transports, commerces, piscine/spa/sauna, qualité du bâtiment, exploitant si documenté...). Ne transforme pas en inventaire.

BLOC 5 — APPEL À L'ACTION : court, en 2 lignes distinctes séparées (RDV conseiller / comparer les biens LMNP avec le chat 7j/7 de La Centrale du LMNP).

=== FISCALITÉ ET SÉCURITÉ — INTERDICTIONS STRICTES ===

Ne jamais affirmer : "zéro impôt", "exonération d'impôt garantie", "revenus totalement défiscalisés", "loyers nets d'impôts", "aucun impôt pendant X années", "loyers garantis", "revenus garantis", "investissement sans risque", "aucune vacance locative", "aucun risque d'impayé", "rentabilité garantie", "investissement totalement sécurisé". Préfère : "L'exploitant locataire verse au propriétaire le loyer prévu au bail commercial selon les conditions contractuelles, indépendamment de l'occupation effective du logement."

INTERDICTION ÉTENDUE (au-delà de la liste ci-dessus, toute la famille "certitude absolue") : n'utilise JAMAIS les mots "sécurisé", "sécurisée", "sécuriser", "sécurité", "garanti", "garantie", "garantissant" ou "garantit" pour qualifier l'investissement, le placement, les revenus locatifs, la rentabilité, la demande locative ou le marché — même en dehors des formulations strictes listées ci-dessus, et même quand la donnée sous-jacente (ex: tension du marché étudiant) est réelle : le mot lui-même suggère une certitude absolue que ce cadre réglementé interdit d'affirmer, quel que soit ce qu'il qualifie précisément. Utilise à la place des formulations factuelles et mesurées ("la demande reste forte", "le marché est tendu", "le loyer est versé selon les conditions du bail") plutôt qu'un qualificatif de certitude absolue. Ces mots restent acceptables uniquement pour un sens sans rapport avec l'investissement ou le marché (ex: sécurité du bâtiment, digicode, garantie décennale du bâtiment) — jamais pour qualifier le placement, les revenus, la demande ou le marché.

=== MARCHÉ SECONDAIRE ===

Ce pipeline ne diffuse que du LMNP d'occasion / marché secondaire — valorise-le comme une sécurité quand pertinent : résidence déjà construite et exploitée, historique d'exploitation existant, bail commercial déjà en place, loyer contractuel déjà connu, perception immédiate de revenus locatifs. Ne jamais affirmer automatiquement qu'un LMNP d'occasion est moins cher que le neuf sans donnée le démontrant.

=== CONTRÔLE QUALITÉ AVANT DE RÉPONDRE ===

Vérifie silencieusement : ai-je inventé une information ? Ai-je confondu promoteur et exploitant ? Ai-je correctement identifié la catégorie de résidence ? Ai-je évité toute confusion résidence senior / EHPAD ? Le titre fait-il 55-60 caractères et contient-il LMNP ? Les chiffres affichés viennent-ils exclusivement du bloc DONNÉES CONNUES ? Ai-je évité toute promesse fiscale ou de sécurité absolue ? Ai-je respecté la structure en 5 blocs avec intertitres en majuscules ?

=== FORMAT DE SORTIE ===

Réponds UNIQUEMENT avec un objet JSON strictement conforme à cette structure, sans aucun markdown ni texte autour :
{"titre": "...", "texte": "..."}

"titre" : le titre (55-60 caractères).
"texte" : la description complète prête à publier, avec les 5 blocs, intertitres en MAJUSCULES sur leur propre ligne, une ligne vide entre chaque paragraphe et avant/après chaque intertitre, paragraphes courts (2-3 phrases max).

Ne retourne rien d'autre : pas ton analyse, pas les informations écartées, pas tes raisonnements, pas de commentaire sur la qualité du dossier.`;

async function callOpenAILmnp(textContext, base64Images, lot) {
    const donneesFiables = donneesFinancieresFiablesDepuisLot(lot);
    const residenceType = lot.program?.residenceType || null;

    let blocDonneesConnues = 'DONNÉES CONNUES AVEC CERTITUDE :\n';
    blocDonneesConnues += residenceType ? `- Catégorie de résidence (Otaree) : ${residenceType}\n` : '- Catégorie de résidence : non fournie, déduis-la du contexte disponible sans jamais confondre senior et EHPAD.\n';
    if (donneesFiables?.prix != null) blocDonneesConnues += `- Prix : ${donneesFiables.prix} €\n`;
    if (donneesFiables?.loyerMensuel != null) blocDonneesConnues += `- Loyer mensuel : ${donneesFiables.loyerMensuel} € (loyer annuel = x12)\n`;
    if (donneesFiables?.rentabilite != null) {
        blocDonneesConnues += `- Rentabilité : ${donneesFiables.rentabilite}% (déjà calculée, méthode loyer HT x12/prix HT — utilise cette valeur telle quelle, ne recalcule jamais)\n`;
    } else {
        blocDonneesConnues += `- Rentabilité : non disponible avec certitude — omets la ligne "Rentabilité" dans les chiffres clés.\n`;
    }

    const messageContent = [
        { type: 'text', text: blocDonneesConnues + '\n\nDonnées structurées complètes du lot :\n\n' + (textContext || '(Aucun texte, base-toi sur les images)') },
    ];
    for (const img of base64Images) {
        messageContent.push({ type: 'image_url', image_url: { url: img } });
    }

    let response;
    for (let tentative = 1; tentative <= 3; tentative++) {
        try {
            response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-4o',
                messages: [{ role: 'system', content: PROMPT_SYSTEME_LMNP_V2 }, { role: 'user', content: messageContent }],
                temperature: 0.7,
                max_tokens: 2000,
                // Mode JSON strict d'OpenAI — sans ça, un texte long avec guillemets/apostrophes
                // (ex: nom de résidence entre guillemets dans la description) peut produire un
                // JSON mal formé et faire échouer JSON.parse malgré le prompt qui le demande déjà
                // en texte. Constaté en conditions réelles (lot Le Havre) : erreur de parsing
                // JSON alors que les 2 autres lots testés en même temps ont fonctionné.
                response_format: { type: 'json_object' },
            }, {
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
            });
            break;
        } catch (e) {
            if (e.response?.status !== 429 || tentative === 3) throw e;
            const delaiMs = 1000 * 2 ** (tentative - 1);
            console.log(`[callOpenAILmnp] 429 (limite de débit) — nouvelle tentative dans ${delaiMs}ms (${tentative}/3)`);
            await new Promise((r) => setTimeout(r, delaiMs));
        }
    }

    await enregistrerUsageOpenAI(response.data.usage);

    let content = response.data.choices[0].message.content;
    content = content.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
    const resultat = JSON.parse(content);
    return { titre: resultat.titre, texte: resultat.texte };
}

// TEMPORAIRE — comparaison ponctuelle de coût/qualité entre modèles pour le chantier de
// réduction du coût de génération IA. Mêmes prompt/données/images que callOpenAILmnp, seul le
// modèle change. N'appelle PAS enregistrerUsageOpenAI (tarif GPT-4o codé en dur, fausserait le
// suivi de dépense pour des modèles moins chers) — le coût réel par modèle est calculé et
// retourné directement dans la réponse pour ce diagnostic. À retirer une fois la comparaison faite.
async function callOpenAILmnpAvecModele(textContext, base64Images, lot, model) {
    const donneesFiables = donneesFinancieresFiablesDepuisLot(lot);
    const residenceType = lot.program?.residenceType || null;

    let blocDonneesConnues = 'DONNÉES CONNUES AVEC CERTITUDE :\n';
    blocDonneesConnues += residenceType ? `- Catégorie de résidence (Otaree) : ${residenceType}\n` : '- Catégorie de résidence : non fournie, déduis-la du contexte disponible sans jamais confondre senior et EHPAD.\n';
    if (donneesFiables?.prix != null) blocDonneesConnues += `- Prix : ${donneesFiables.prix} €\n`;
    if (donneesFiables?.loyerMensuel != null) blocDonneesConnues += `- Loyer mensuel : ${donneesFiables.loyerMensuel} € (loyer annuel = x12)\n`;
    if (donneesFiables?.rentabilite != null) {
        blocDonneesConnues += `- Rentabilité : ${donneesFiables.rentabilite}% (déjà calculée, méthode loyer HT x12/prix HT — utilise cette valeur telle quelle, ne recalcule jamais)\n`;
    } else {
        blocDonneesConnues += `- Rentabilité : non disponible avec certitude — omets la ligne "Rentabilité" dans les chiffres clés.\n`;
    }

    const messageContent = [
        { type: 'text', text: blocDonneesConnues + '\n\nDonnées structurées complètes du lot :\n\n' + (textContext || '(Aucun texte, base-toi sur les images)') },
    ];
    for (const img of base64Images) {
        messageContent.push({ type: 'image_url', image_url: { url: img } });
    }

    // Les modèles GPT-5 refusent `max_tokens` (paramètre renommé `max_completion_tokens`) —
    // gpt-4o/gpt-4o-mini acceptent encore l'ancien nom, utilisé partout ailleurs dans ce fichier.
    const estGpt5 = model.startsWith('gpt-5');
    const body = {
        model,
        messages: [{ role: 'system', content: PROMPT_SYSTEME_LMNP_V2 }, { role: 'user', content: messageContent }],
        temperature: 0.7,
        response_format: { type: 'json_object' },
    };
    body[estGpt5 ? 'max_completion_tokens' : 'max_tokens'] = 2000;

    const response = await axios.post('https://api.openai.com/v1/chat/completions', body, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    });

    let content = response.data.choices[0].message.content;
    content = content.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
    const resultat = JSON.parse(content);
    return { titre: resultat.titre, texte: resultat.texte, usage: response.data.usage };
}

app.post('/api/diag-compare-modeles', async (req, res) => {
    const { lot, modeles } = req.body || {};
    if (!lot || typeof lot !== 'object') return res.status(400).json({ success: false, error: 'lot requis' });
    const listeModeles = Array.isArray(modeles) && modeles.length ? modeles : ['gpt-4o', 'gpt-4o-mini', 'gpt-5-nano'];
    try {
        const lotImageData = await downloadOtareeImages(lot);
        const lotImages = lotImageData.map(img => img.data);
        const contexte = buildTextContext(lot);
        const resultats = {};
        for (const model of listeModeles) {
            try {
                resultats[model] = await callOpenAILmnpAvecModele(contexte, lotImages, lot, model);
            } catch (e) {
                resultats[model] = { error: e.response?.data ? JSON.stringify(e.response.data).substring(0, 500) : e.message };
            }
        }
        res.json({ success: true, resultats, nbImages: lotImages.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/generate', async (req, res) => {
    try {
        const { lot, imagesSelection } = req.body || {};
        if (!lot || typeof lot !== 'object') return res.status(400).json({ success: false, error: 'lot requis' });

        const lotImageData = await downloadOtareeImages(lot, imagesSelection);
        const lotImages = lotImageData.map(img => img.data);
        const villeConnue = lot.program?.address?.city?.name || null;
        const codePostalConnu = lot.program?.address?.zipCode || null;

        // Prompt V2 dédié pour les lots LMNP (2/21/30/32) — titre+texte seulement, le reste des
        // champs structurés vient directement des données Otaree connues, jamais de l'IA. Tout
        // autre dispositif (Pinel, autres lois, Neuf) garde le prompt générique existant inchangé.
        let aiData;
        if (estLotLmnp(lot)) {
            const { titre, texte } = await callOpenAILmnp(buildTextContext(lot), lotImages, lot);
            aiData = { ...champsConnusDepuisLot(lot), titre, texte };
        } else {
            aiData = await callOpenAI(buildTextContext(lot), lotImages);
        }
        res.json({ success: true, aiData, images: lotImages, villeConnue, codePostalConnu });
    } catch (error) {
        let errorMsg = error.message;
        if (error.response && error.response.data) errorMsg += ' - ' + JSON.stringify(error.response.data);
        res.status(500).json({ success: false, error: errorMsg });
    }
});

// Tarif officiel gpt-4o (2,50$/million tokens en entrée, 10$/million en sortie) — à mettre à
// jour si le modèle change un jour (voir l'appel plus bas, "gpt-4o" en dur). Sert au plafond de
// dépense (voir dashboard/server/src/services/depenseMonitor.js) : chaque appel réel enregistre
// son coût exact ici, pas une estimation a posteriori.
const TARIF_GPT4O_USD_PAR_TOKEN = { entree: 2.5 / 1_000_000, sortie: 10 / 1_000_000 };

async function enregistrerUsageOpenAI(usage) {
    if (!usage) return;
    const coutUsd = usage.prompt_tokens * TARIF_GPT4O_USD_PAR_TOKEN.entree + usage.completion_tokens * TARIF_GPT4O_USD_PAR_TOKEN.sortie;
    try {
        await db
            .prepare(`INSERT INTO openai_usage_log (prompt_tokens, completion_tokens, cout_usd) VALUES (?, ?, ?)`)
            .run(usage.prompt_tokens, usage.completion_tokens, coutUsd);
    } catch (e) {
        // Ne doit jamais faire échouer la génération elle-même — juste un manque de suivi pour
        // le plafond de dépense, pas une raison de bloquer une annonce réelle.
        console.error('[enregistrerUsageOpenAI] échec de l\'enregistrement :', e.message);
    }
}

async function callOpenAI(textContext, base64Images) {
    const systemPrompt = `Agis comme un expert immobilier de la loi Pinel et LMNP, rédacteur pour une agence haut de gamme. Tu dois lire ATTENTIVEMENT toutes les informations fournies (textes, documents extraits de PDF, ou plans en image) et en extraire un MAXIMUM de détails concrets et vérifiables pour rédiger une annonce précise, complète et jamais générique.
Renvoie UNIQUEMENT un objet JSON strictement conforme à la structure suivante, sans aucun markdown ni texte autour :
{
  "titre": "...",
  "titre_alternatif": "...",
  "texte_resume": "...",
  "texte": "...",
  "reference": "...",
  "prix": "...",
  "surface": "...",
  "pieces": "...",
  "etage": "...",
  "code_postal": "...",
  "ville": "...",
  "date_livraison": "...",
  "surface_sejour": "...",
  "nb_chambres": "...",
  "nb_salles_d_eau": "...",
  "nb_wc": "...",
  "balcon": "...",
  "nb_balcons": "...",
  "surface_balcon": "...",
  "parking": "...",
  "nb_parkings": "...",
  "exposition": "...",
  "dpe_conso": "...",
  "dpe_ges": "...",
  "proche_commerces": "..."
}`;

    let messageContent = [{ "type": "text", "text": "Voici les données extraites :\n\n" + (textContext || "(Aucun texte, base-toi sur les images)") }];

    // Filet de sécurité ajouté avec la génération IA en parallèle sur plusieurs lots (voir
    // orchestrator.js, CONCURRENCE_ENRICHISSEMENT_IA) : aucune gestion de 429 n'existait avant
    // (même en séquentiel), donc un dépassement de palier faisait simplement échouer le lot.
    // Nouvelle tentative avec délai croissant, seulement sur 429 — toute autre erreur remonte
    // immédiatement, inchangé.
    let response;
    for (let tentative = 1; tentative <= 3; tentative++) {
        try {
            response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: "gpt-4o",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: messageContent }],
                temperature: 0.7,
                max_tokens: 2000
            }, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
                }
            });
            break;
        } catch (e) {
            if (e.response?.status !== 429 || tentative === 3) throw e;
            const delaiMs = 1000 * 2 ** (tentative - 1);
            console.log(`[callOpenAI] 429 (limite de débit) — nouvelle tentative dans ${delaiMs}ms (${tentative}/3)`);
            await new Promise((r) => setTimeout(r, delaiMs));
        }
    }

    await enregistrerUsageOpenAI(response.data.usage);

    let content = response.data.choices[0].message.content;
    content = content.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
    return JSON.parse(content);
}

function buildUbiflowPayload(aiData, base64Images = [], donneesConnues = {}, espaceLogin) {
    const annonce = {
        communiquer_adresse_exacte: "oui",
        nbDiffusions: 0,
        typeOffre: "V", 
        typeObjet: 1100,
        photos: base64Images.map(b64 => ({ type: "base64", url: b64 })),
        contact_a_afficher: "La Centrale du Neuf Plusimmo",
        email_a_afficher: "accueil@plusimmo76.fr",
        telephone_a_afficher: "02 32 86 47 72",
        telephone_mobile_a_afficher: "",
        adresse_contact_a_afficher: "49 RUE JEANNE D ARC",
        code_postal_contact_a_afficher: "76000",
        ville_contact_a_afficher: "ROUEN",
        id_contact_a_afficher: 146265, 
        devise_iso_4217: "EUR",
        afficher_prix: "oui",
        reference: (aiData.reference || "LMNP") + "-" + Math.floor(Math.random() * 10000),
        titre: aiData.titre || "Annonce LMNP",
        titre_alternatif: aiData.titre_alternatif || aiData.titre || "Annonce LMNP",
        texte_resume: aiData.texte_resume || "",
        localText: aiData.texte || "Description à rédiger",
        texte: aiData.texte || "Description à rédiger",
        // Le prix vient TOUJOURS de la valeur connue et fiable (celle d'Otaree, déjà en base
        // côté dashboard), jamais de la relecture par l'IA — celle-ci reformate parfois le
        // prix avec des espaces/virgules ("76 208,31 €"), et parseInt() tronque au premier
        // caractère non numérique (76 208 -> 76), publiant un prix ~1000x trop bas sans aucune
        // erreur visible. Un fait déjà connu avec certitude ne doit jamais être laissé à
        // l'interprétation de l'IA — même principe que pour titre/description : ne présenter
        // que ce qui est réellement fiable, jamais une reformulation qui peut se tromper. Repli
        // sur aiData.prix uniquement si le prix connu est vraiment absent (ne devrait pas
        // arriver en usage normal).
        prix: donneesConnues.prix != null ? Math.round(Number(donneesConnues.prix)) : (parseInt(aiData.prix) || 0),
        surface_habitable: (parseInt(aiData.surface) || 0).toString(),
        nb_pieces_logement: parseInt(aiData.pieces) || 1,
        code_postal_reel: donneesConnues.codePostal ? String(donneesConnues.codePostal) : (aiData.code_postal ? String(aiData.code_postal) : "76000"),
        ville_reelle: donneesConnues.ville ? String(donneesConnues.ville) : (aiData.ville ? String(aiData.ville) : "Rouen"),
        visite_dateVisite: null,
        visite_horaireVisite: null,
        visite_nbPersonne: null
    };

    const num = (v) => (v === null || v === undefined || v === '' || isNaN(parseInt(v))) ? null : parseInt(v);
    const bool = (v) => (v === true || v === false) ? v : null;

    if (num(aiData.surface_sejour) !== null) annonce.surface_sejour = num(aiData.surface_sejour);
    if (num(aiData.nb_chambres) !== null) annonce.nombre_de_chambres = num(aiData.nb_chambres);
    if (num(aiData.nb_salles_d_eau) !== null) annonce.nb_salles_d_eau = num(aiData.nb_salles_d_eau);
    if (num(aiData.nb_wc) !== null) annonce.nb_wc = num(aiData.nb_wc);

    const hasBalcon = bool(aiData.balcon);
    if (hasBalcon !== null) {
        annonce.balcon = hasBalcon;
        if (num(aiData.nb_balcons) !== null) annonce.nb_balcons = num(aiData.nb_balcons);
        if (num(aiData.surface_balcon) !== null) annonce.surface_balcon = num(aiData.surface_balcon);
    }

    const hasParking = bool(aiData.parking);
    if (hasParking !== null) {
        annonce.possede_parking = hasParking;
        annonce.avec_stationnement = hasParking;
        if (num(aiData.nb_parkings) !== null) annonce.nb_parkings = num(aiData.nb_parkings);
    }

    if (aiData.exposition && typeof aiData.exposition === 'string' && aiData.exposition.toLowerCase() !== 'null') {
        annonce.exposition = aiData.exposition.toLowerCase().trim();
    }

    if (aiData.dpe_conso) annonce.dpe_etiquette_conso = aiData.dpe_conso;
    if (aiData.dpe_ges) annonce.dpe_etiquette_ges = aiData.dpe_ges;
    if (aiData.dpe_conso || aiData.dpe_ges) annonce.soumis_dpe = true;
    if (bool(aiData.proche_commerces) !== null) annonce.proche_commerces = bool(aiData.proche_commerces);

    return {
        action: "saveDraft",
        universe: "IMMO",
        annonce,
        flux: { code: AGENCE_CONFIG.flux_code },
        annonceur: { login: espaceLogin }
    };
}

// Sur Vercel, `VERCEL` est toujours défini (peu importe NODE_ENV) — écouter un port n'a aucun
// sens là-bas (fonction serverless, pas de process persistant). Partout ailleurs (local, Render,
// tout hébergeur classique), on démarre un vrai serveur qui tourne en continu.
if (!process.env.VERCEL) {
    const PORT = process.env.PORT || 4000;
    // '0.0.0.0' explicite — voir le commentaire équivalent dans dashboard/server/src/index.js.
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[🚀] API Ubiflow Automatisée démarrée sur http://localhost:${PORT}`);
    });
}

module.exports = app;
