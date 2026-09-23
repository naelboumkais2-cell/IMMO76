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

// EXCEPTION DE SÉCURITÉ DÉLIBÉRÉE ET STRICTEMENT BORNÉE — NE JAMAIS ÉLARGIR NI COPIER CE PATTERN
// POUR D'AUTRES CHAMPS. Contexte (2026-09-06) : un bug de rate-limit Otaree (voir enrichirLot,
// dashboard/server/src/integrations/otareeSearchClient.js) a fait publier ~104 annonces réelles
// sans aucune photo sur Hubiflow. Cette fonction rattrape a posteriori les seules PHOTOS de ces
// annonces déjà réellement publiées, sans jamais toucher texte/prix/statut/quoi que ce soit
// d'autre. Contrairement à publish()/envoyerAUbiflow (création complète d'annonce, protégée côté
// dashboard/server par la liste blanche est_annonce_test — voir hubiflowClientReel.js), cette
// fonction ne construit JAMAIS qu'un payload {photos: [...]} : elle est structurellement
// incapable de modifier autre chose, quel que soit l'appelant, précisément parce qu'aucun autre
// champ ne lui est jamais passé. Si un futur besoin nécessite d'élargir ce PATCH à d'autres
// champs (texte, prix, statut...) sur une annonce déjà réelle, il DOIT repasser par la même
// liste blanche que publish(), jamais par ce raccourci minimaliste.
async function patcherPhotosHubiflow(adId, base64Images, token, espaceLogin) {
    const adIdPropre = parseInt(adId, 10);
    const annonceurId = parseInt(String(espaceLogin).replace(/\D/g, ''), 10);
    try {
        const response = await axios.patch(
            `https://espace-client-backend.ubiflow.net/annonce/${adIdPropre}`,
            {
                annonceur: { id: annonceurId },
                flux: { code: AGENCE_CONFIG.flux_code },
                annonce: { photos: base64Images.map((b64) => ({ type: 'base64', url: b64 })) }
            },
            {
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Content-Type': 'application/json;charset=UTF-8',
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        return { success: true, data: response.data };
    } catch (error) {
        let errorMsg = error.message;
        if (error.response) errorMsg += ' - ' + JSON.stringify(error.response.data).substring(0, 500);
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

// Voir l'avertissement au-dessus de patcherPhotosHubiflow : n'accepte QUE base64Images en entrée,
// aucun autre champ (texte/prix/statut) n'est même lisible depuis req.body ici — la restriction
// est structurelle, pas une simple validation contournable.
app.post('/api/annonce/:id/photos', async (req, res) => {
    const { base64Images, espaceLoginAttendu } = req.body || {};
    if (!espaceLoginAttendu) return res.status(400).json({ success: false, error: 'espaceLoginAttendu requis' });
    if (!Array.isArray(base64Images) || base64Images.length === 0) {
        return res.status(400).json({ success: false, error: 'base64Images requis (tableau non vide)' });
    }
    const resolu = await resoudreTokenPourEspace(espaceLoginAttendu);
    if (resolu.erreur) return res.status(401).json({ success: false, error: resolu.erreur });

    const result = await patcherPhotosHubiflow(req.params.id, base64Images, resolu.token, espaceLoginAttendu);
    res.status(result.success ? 200 : 502).json(result);
});

// Téléchargement de photos seul, sans génération IA — utilisé pour rattraper les photos
// d'annonces déjà publiées (voir /api/annonce/:id/photos) sans jamais toucher au texte existant,
// contrairement à /api/generate qui régénère systématiquement titre+texte.
app.post('/api/telecharger-photos', async (req, res) => {
    try {
        const { lot, imagesSelection } = req.body || {};
        if (!lot || typeof lot !== 'object') return res.status(400).json({ success: false, error: 'lot requis' });
        const lotImageData = await downloadOtareeImages(lot, imagesSelection);
        res.json({ success: true, images: lotImageData.map((img) => img.data) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
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
    const { aiData, base64Images, villeConnue, codePostalConnu, prixConnu, referenceConnue, espaceLoginAttendu, mode } = req.body;

    if (!espaceLoginAttendu) return res.status(400).json({ success: false, error: 'espaceLoginAttendu requis' });
    if (!aiData) return res.status(400).json({ success: false, error: 'aiData manquant' });

    const resolu = await resoudreTokenPourEspace(espaceLoginAttendu);
    if (resolu.erreur) return res.status(401).json({ success: false, error: resolu.erreur });

    const payload = buildUbiflowPayload(aiData, base64Images || [], { ville: villeConnue, codePostal: codePostalConnu, prix: prixConnu, reference: referenceConnue }, espaceLoginAttendu);
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

    // Exclut les plans qui se glissent parmi les photos — même motif que verifierDocumentsPlan
    // (lot.documents), jamais branché jusqu'ici sur lot.images. Constaté en conditions réelles
    // (programme "Lorine") : des plans 3D enregistrés en JPEG ("Lorine_Plan 3D_B209 T3.jpg")
    // passaient tous les filtres existants (mimeType image/jpeg valide) et pouvaient se retrouver
    // n'importe où dans l'ordre, y compris en première position, par pur hasard alphabétique.
    // Inconditionnel, même si sélectionné manuellement comme "premiere" par erreur sur l'écran de
    // confirmation (qui affiche encore ces images sans les identifier comme plans) : jamais publier
    // un plan comme photo de couverture, même sur mauvaise manipulation humaine.
    const sorted = [...images]
        .filter((img) => !exclues.has((img.name || '').toLowerCase()))
        .filter((img) => !/plan/i.test(img.name || ''))
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

// Sépare "numéro de voie" et "adresse" (nom de voie) depuis le texte libre program.address.name
// d'Otaree — validé sur 35 adresses réelles (Rouen/Marseille, 2026-09-10). Deux étapes : (1)
// retire un éventuel suffixe ", <code postal> <ville>" redondant — Otaree duplique parfois le
// code postal/ville dans l'adresse elle-même, alors qu'on les connaît déjà séparément
// (codePostal/ville du lot) ; (2) extrait un numéro en tête (avec bis/ter/quater optionnel) si
// présent — sinon numéro reste null et le texte va dans "voie" (voir plus bas pour le cas " et ").
//
// Un " et " entre deux noms de voie (ex: "90 avenue du Mont Riboudet et Rue du Pré de la
// Bataille") a d'abord semblé un simple cas verbeux sans perte d'info à garder tel quel — vérifié
// en conditions réelles (2026-09-10, ce même exemple) que c'est FAUX : "rue du Pré de la
// Bataille" n'était qu'une rue adjacente servant de repère, pas une vraie double façade. Dans ce
// cas, seule la première voie (la vraie adresse) est gardée — tout ce qui suit " et " est
// considéré comme un simple repère de proximité, pas une partie fiable de l'adresse.
function extraireNumeroVoie(nomAdresse, codePostal, ville) {
    if (!nomAdresse) return { numero: null, voie: null };
    let texte = String(nomAdresse).trim();
    if (codePostal && ville) {
        const suffixe = new RegExp(`,?\\s*${codePostal}\\s+${ville}\\s*$`, 'i');
        texte = texte.replace(suffixe, '').trim();
    }
    texte = texte.replace(/\s*,\s*$/, '').trim();
    texte = texte.replace(/\s+\bet\b.*$/i, '').trim();
    const m = texte.match(/^(\d+\s?(?:bis|ter|quater)?)\s*,?\s+(.+)$/i);
    if (m) return { numero: m[1].trim(), voie: m[2].trim() };
    return { numero: null, voie: texte };
}

// Extrait la lettre DPE (A-G) d'un texte libre "description" Otaree quand energyClass est
// absent — formats réels observés : "Classe énergétique : <strong>C</strong>" et
// "DPE : C / GES : C" (2026-09-12, test réel Rouen + lots Advenis vus plus tôt). Capture
// uniquement la lettre qui suit IMMÉDIATEMENT le label DPE/classe énergétique — jamais la lettre
// GES même quand les deux se suivent dans la même description, jamais une valeur par défaut.
function extraireDpeDepuisDescription(description) {
    if (typeof description !== 'string' || !description) return null;
    const m = description.match(/(?:classe\s+[ée]nerg[ée]tique|\bDPE)\s*:?\s*(?:<[^>]+>\s*)?([A-G])\b/i);
    return m ? m[1].toUpperCase() : null;
}

// Extrait la lettre GES (gaz à effet de serre) d'un texte libre "description" Otaree — aucun champ
// structuré équivalent à energyClass n'existe pour le GES (vérifié sur un vrai lot complet,
// 2026-09-20 : aucune clé ghg/co2/climat/ges au niveau du lot), donc uniquement ce repli texte,
// jamais de valeur par défaut. Deux formulations réelles observées selon le gestionnaire/template
// source, mutuellement exclusives sur un échantillon de 1288 lots réels (jamais les deux à la
// fois sur un même lot) : "Classe GES : B" (Pierre & Vacances, Center Parcs, Adagio...) et
// "Classe climat : A" (autre gamme de programmes). Confirmé sur cet échantillon que la lettre GES
// diffère du DPE dans la majorité des cas (ex. DPE D / GES B) — une vraie donnée distincte, pas
// une répétition du DPE comme on l'avait supposé à tort en écartant "Classe climat" la première
// fois qu'elle avait été repérée.
function extraireGesDepuisDescription(description) {
    if (typeof description !== 'string' || !description) return null;
    const m = description.match(/(?:\bGES\b|classe\s+climat)\s*:?\s*(?:<[^>]+>\s*)?([A-G])\b/i);
    return m ? m[1].toUpperCase() : null;
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

    // BALCON, TERRASSE et LOGGIA étaient auparavant fusionnés sous un seul champ "balcon" —
    // séparés depuis l'inventaire des champs Hubiflow exploitables (2026-09-10) : ce sont trois
    // annexes distinctes côté Otaree (LOGGIA découvert par échantillonnage réel, pas dans la
    // liste initiale), donc trois champs distincts côté Hubiflow, jamais confondus entre eux.
    if (Array.isArray(lot.annexesSurfaces)) {
        const balcons = lot.annexesSurfaces.filter((a) => a.type === 'BALCON');
        champs.balcon = balcons.length > 0;
        if (balcons.length > 0) {
            champs.nb_balcons = String(balcons.length);
            if (typeof balcons[0].surface === 'number') champs.surface_balcon = String(balcons[0].surface);
        }

        const terrasses = lot.annexesSurfaces.filter((a) => a.type === 'TERRASSE');
        champs.terrasse = terrasses.length > 0;
        if (terrasses.length > 0) {
            champs.nb_terrasses = String(terrasses.length);
            if (typeof terrasses[0].surface === 'number') champs.surface_terrasse = String(terrasses[0].surface);
        }

        champs.loggia = lot.annexesSurfaces.some((a) => a.type === 'LOGGIA');
    }

    if (typeof lot.parkingCount === 'number') {
        champs.parking = lot.parkingCount > 0;
        champs.nb_parkings = String(lot.parkingCount);
    }

    // Garage/box/cave : uniquement sur correspondance EXACTE du type d'annexe Otaree (aucune
    // déduction) — décidé après l'inventaire des champs Hubiflow (2026-09-10). `lot.annexes[].type`
    // liste les annexes chiffrées du lot (garage et cave confirmés sur des lots réels, y compris
    // un lot avec les deux à la fois ; box non encore observé sur un lot réel mais même logique
    // exacte, restera `false` tant qu'aucun lot BOX ne se présente). CELLIER et LOCAL, vus sur
    // d'autres lots réels, sont volontairement ignorés (pas de champ Hubiflow correspondant
    // confirmé) — ne pas les confondre avec CAVE.
    if (Array.isArray(lot.annexes)) {
        const garages = lot.annexes.filter((a) => a.type === 'GARAGE');
        champs.garage = garages.length > 0;
        if (garages.length > 0) champs.nb_garages = String(garages.length);

        champs.box = lot.annexes.some((a) => a.type === 'BOX');
        champs.cave = lot.annexes.some((a) => a.type === 'CAVE');
    }

    if (Array.isArray(lot.exposures) && lot.exposures.length > 0) {
        champs.exposition = lot.exposures.join('').toLowerCase();
    }

    // energyClass est une lettre (A-G) quand elle est connue — jamais une consommation chiffrée
    // (qu'on n'a pas) : on ne remplit dpe_conso/dpe_ges que si la lettre est réellement présente,
    // jamais une valeur par défaut.
    //
    // Repli sur lot.description (2026-09-12, test réel Rouen) : constaté que energyClass est
    // souvent null alors que la lettre DPE est réellement présente en texte libre dans la
    // description Otaree ("Classe énergétique : C", ou "DPE : C / GES : C" sur d'autres lots) —
    // jamais inventée, juste dans un champ différent de celui qu'on lisait. Sans ce repli, le
    // texte généré mentionnait correctement "Classe énergétique C" (lu depuis la description,
    // transmise telle quelle au modèle) alors que la case DPE Hubiflow restait vide, faute de
    // valeur structurée à envoyer. Capture UNIQUEMENT la lettre qui suit immédiatement le label
    // DPE/classe énergétique — jamais la lettre GES, même quand les deux apparaissent l'un après
    // l'autre dans la même description (voir extraireGesDepuisDescription juste en dessous,
    // extraction désormais bien réelle et distincte depuis le 2026-09-20).
    const dpeDepuisDescription = extraireDpeDepuisDescription(lot.description);
    if (typeof lot.energyClass === 'string' && lot.energyClass) {
        champs.dpe_conso = lot.energyClass;
    } else if (dpeDepuisDescription) {
        champs.dpe_conso = dpeDepuisDescription;
    }

    // Lettre GES — aucun champ structuré équivalent à energyClass (vérifié, voir
    // extraireGesDepuisDescription) : uniquement le repli texte, jamais une valeur par défaut.
    const gesDepuisDescription = extraireGesDepuisDescription(lot.description);
    if (gesDepuisDescription) champs.dpe_ges = gesDepuisDescription;

    // Surface du terrain : uniquement si réellement > 0 (0 est la valeur par défaut pour un
    // appartement sans terrain propre — l'omettre plutôt que d'afficher "0 m²" sur l'annonce).
    if (typeof lot.landSurface === 'number' && lot.landSurface > 0) {
        champs.surface_terrain = String(lot.landSurface);
    }

    // Latitude/longitude/adresse du programme (Otaree ne les fournit qu'au niveau du programme,
    // pas du lot individuel — mêmes coordonnées/adresse pour tous les lots d'un même programme).
    const adresse = lot.program?.address;
    if (adresse?.latitude) champs.latitude = String(adresse.latitude);
    if (adresse?.longitude) champs.longitude = String(adresse.longitude);

    const { numero, voie } = extraireNumeroVoie(adresse?.name, adresse?.zipCode, adresse?.city?.name);
    if (numero) champs.numero_voie = numero;
    if (voie) champs.adresse = voie;

    return champs;
}

// Rentabilité Otaree (prices[0].profitability) — décision explicite du client (2026-09-20) :
// affichée systématiquement dès qu'elle est présente, quel que soit vatRate et quelle que soit la
// méthode de calcul sous-jacente côté Otaree. Revient sur la restriction précédente (vatRate === 0
// uniquement) qui avait été posée par prudence après une vérification empirique du 2026-08-30
// montrant que la méthode réelle d'Otaree divergeait parfois de loyer HT x12/prix HT hors de ce
// cas — le client a tranché : il fait confiance à la donnée Otaree telle quelle, pas de contrôle
// croisé. Le garde-fou anti-donnée aberrante ci-dessous reste néanmoins en place : il protège
// contre une erreur de saisie dans la donnée source elle-même (constaté une fois : un loyer sans
// rapport plausible avec le prix, ~50% de rendement implicite), pas contre la méthode de calcul —
// hors sujet de cette décision.
function donneesFinancieresFiablesDepuisLot(lot) {
    const p = lot.prices?.[0];
    if (!p) return null;
    const donnees = {};
    if (typeof p.price === 'number') donnees.prix = p.price;

    if (typeof p.price === 'number' && p.price > 0 && typeof p.monthlyRent === 'number') {
        const rendementImplicite = (p.monthlyRent * 12 / p.price) * 100;
        // Garde-fou anti-donnée aberrante (inchangé) : rendement implicite hors de toute
        // plausibilité pour du LMNP géré (typiquement 2 à 7%, marge large jusqu'à 15%).
        if (rendementImplicite >= 1 && rendementImplicite <= 15) {
            donnees.loyerMensuel = p.monthlyRent;
            if (typeof p.profitability === 'number') donnees.rentabilite = p.profitability;
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

DPE ET GES — NE JAMAIS LES MENTIONNER DANS LE TEXTE (règle client, 2026-09-23) : le DPE et le GES ne doivent JAMAIS apparaître dans l'annonce, ni dans les chiffres clés ni ailleurs dans le texte — ces informations restent exclusivement dans les champs structurés réglementaires de l'annonce, gérés séparément de ce texte commercial. N'aborde jamais le sujet de la performance énergétique, même si une lettre DPE ou GES apparaît dans les données brutes fournies.

=== PRINCIPE FONDAMENTAL : ANALYSER AVANT DE RÉDIGER ===

Avant de rédiger l'annonce, analyse l'intégralité des informations disponibles afin d'établir une fiche fiable du bien. Cette analyse est une étape interne, elle ne doit pas apparaître dans l'annonce finale. Identifie : la catégorie exacte de résidence, le type de logement, la surface, les annexes, le prix, le loyer, la rentabilité si fournie, les caractéristiques de la résidence, les services, l'emplacement, les points d'intérêt, les arguments commerciaux réellement différenciants. Ne cherche pas à utiliser toutes les informations disponibles — identifie les plus utiles.

=== HIÉRARCHIE ET FIABILITÉ DES SOURCES ===

Pour les informations contractuelles, privilégie toujours les documents contractuels (absents ici, donc omets toute affirmation contractuelle spécifique à ce bien au-delà du fonctionnement général du LMNP géré). En cas de contradiction entre plusieurs sources, utilise la plus fiable. Si le doute subsiste, n'utilise pas l'information.

N'écris JAMAIS de phrase qui commente l'absence elle-même d'une information contractuelle ou documentaire (ex: "sans référence contractuelle spécifique dans ce dossier", "on ne communique pas d'occupation personnelle prévue sans document officiel", "en l'absence d'indications sur ce point, aucune affirmation ne peut être faite") — ce type de méta-commentaire révèle le fonctionnement interne de la génération et n'a rien à faire dans une annonce commerciale. La règle reste la même que partout ailleurs : quand une information manque, tu l'omets silencieusement, tu n'expliques jamais pourquoi elle manque ni ce qui permettrait de la confirmer.

=== TITRE (règles précises du client, 2026-09-23) ===

Objectif explicite : le titre doit immédiatement signaler qu'il s'agit d'un investissement locatif, jamais d'un logement à habiter — aucune confusion possible avec une annonce de résidence principale.

Structure obligatoire : "{Type de bien/résidence} – {formule investissement}".

"{Type de bien/résidence}" : une désignation courte et factuelle du logement et/ou de sa catégorie de résidence (ex: "Chambre EHPAD", "Appartement meublé", "Studio étudiant", "Appartement en résidence affaires", "Appartement en résidence tourisme"). Jamais la ville, jamais le nom de la résidence ou du promoteur, jamais un équipement ou une caractéristique du logement (terrasse, balcon, piscine, exposition, étage, vue...) — contrairement à l'ancienne règle, aucune caractéristique différenciante n'a sa place ici.

"{formule investissement}" : obligatoirement l'une de ces deux formules — "investissement LMNP géré" ou "LMNP 100 % géré" — éventuellement suivie de "– idéal investisseur" en complément (jamais "idéal investisseur" seul, toujours en plus de l'une des deux formules ci-dessus).

Exemples exacts de structure à respecter :
"Chambre EHPAD – investissement LMNP géré – idéal investisseur"
"Appartement meublé – investissement LMNP géré – idéal investisseur"
"Studio étudiant – investissement LMNP géré – idéal investisseur"
"Appartement en résidence affaires – investissement LMNP géré"
"Appartement en résidence tourisme – investissement LMNP géré"
"Appartement meublé – LMNP 100 % géré – idéal investisseur"

Évite superlatifs non justifiés, majuscules inutiles, promesses de sécurité absolue, formulations génériques.

Titre court et lisible — jamais une phrase complète, jamais de remplissage au-delà de la structure ci-dessus. Sa longueur découle naturellement du type de bien/résidence et de la formule choisie, n'ajoute jamais un mot juste pour l'allonger ou le raccourcir artificiellement.

=== LONGUEUR ET STYLE DU DESCRIPTIF ===

Minimum 500 caractères. Cible : environ 1500 à 2200 caractères espaces compris. Cette longueur est une cible, pas une obligation absolue — ne jamais allonger artificiellement, ne jamais produire une annonce excessivement courte si le dossier contient des informations importantes. Style : clair, professionnel, pédagogique, commercial sans excès, fluide, crédible, accessible au grand public, orienté investisseur. Utilise des listes pour les chiffres clés. Évite jargon CGP, formulations administratives, répétitions, superlatifs, slogans génériques. Facile à parcourir sur smartphone.

=== STRUCTURE OBLIGATOIRE (5 BLOCS) ===

BLOC 1 — INTRODUCTION DIRECTE (règle client, 2026-09-23) : PAS d'intertitre en majuscules pour ce premier bloc — commence directement par la phrase "Offre dédiée à l'investissement locatif en LMNP sous bail commercial.", suivie d'une courte explication du fonctionnement dans cet esprit : "Investir en LMNP géré, c'est opter pour un placement locatif où la gestion est confiée à un exploitant professionnel. Vous percevez un loyer selon les conditions du bail commercial, que le bien soit occupé ou non. Ce statut offre également des avantages fiscaux selon votre situation." Adapte légèrement la formulation d'une annonce à l'autre pour éviter une répétition mot pour mot systématique, sans changer le sens ni la structure de ces deux phrases. N'utilise JAMAIS "loyers garantis" ni "nets d'impôts" ou toute formulation équivalente — voir les interdictions strictes ci-dessous, qui s'appliquent aussi à cette introduction. Explique tôt la contrainte principale : le propriétaire ne peut pas habiter librement le logement ni y loger un proche pendant l'exécution du bail commercial — formule cela de façon pédagogique, jamais agressive (jamais "INUTILE DE NOUS CONTACTER POUR Y HABITER"). Comme aucune donnée de bail n'est disponible dans ce dossier, n'affirme jamais qu'une occupation personnelle est prévue — reste sur la règle générale.

BLOC 2 — LES CHIFFRES CLÉS : intertitre "LES CHIFFRES CLÉS" en majuscules sur sa propre ligne, puis une donnée par ligne au format "Libellé : valeur", en n'utilisant QUE les données fournies dans le bloc "DONNÉES CONNUES AVEC CERTITUDE" du message utilisateur (prix, loyer annuel = loyer mensuel x12, rentabilité si fournie). N'affiche jamais une ligne "charges de copropriété", "taxe foncière", "gestion locative", "travaux courants" ou toute autre donnée non explicitement fournie — omets la ligne plutôt que d'écrire "non communiqué(e)". Ne jamais indiquer durée restante du bail, date de renouvellement, fonds travaux, ou effort d'épargne mensuel.

BLOC 3 — POURQUOI CETTE CATÉGORIE ? : intertitre "POURQUOI INVESTIR DANS [TYPE DE RÉSIDENCE] ?" en majuscules, 2 à 4 lignes contextualisant l'investissement selon la catégorie identifiée (utilise les statistiques de marché ci-dessous UNIQUEMENT si elles sont pertinentes pour la catégorie identifiée, jamais inventées) :
- Résidence étudiante : plus de 3 millions d'étudiants pour 400 000 places en résidence étudiante, soit une place pour huit étudiants.
- Résidence services seniors : 22% de la population française a plus de 65 ans aujourd'hui, près de 40% d'ici 15 ans. Une résidence services seniors n'est PAS un EHPAD — jamais de vocabulaire médicalisé si ce n'est pas le cas.
- EHPAD : 1,6 million de personnes de plus de 85 ans aujourd'hui, près de 5 millions en 2050. Environ 92 places en EHPAD pour 1000 personnes de plus de 75 ans ; dans certaines zones, 50 à 100 demandes pour une seule place. Ne jamais présenter un EHPAD comme une résidence services seniors.
- Résidence de tourisme : la France, première puissance touristique mondiale, plus de 100 millions de visiteurs étrangers par an (7% de la richesse nationale, 2 millions d'emplois). Si l'exploitant "Center Parcs" est explicitement identifié (jamais déduit), insère le paragraphe dédié (voir plus haut).
- Résidence affaires : mets en avant clientèle professionnelle, centre-ville, quartier d'affaires, proximité gare/aéroport/métro/tramway UNIQUEMENT si confirmés par les données du lot.

BLOC 4 — LE BIEN ET LA RÉSIDENCE : intertitre "LE BIEN ET LA RÉSIDENCE" en majuscules. Réécris dans un langage naturel (ne recopie jamais mécaniquement un descriptif partenaire). Sélectionne 3 à 6 caractéristiques réellement différenciantes parmi celles confirmées par les données (emplacement, transports, commerces, piscine/spa/sauna, qualité du bâtiment, exploitant si documenté...). Ne transforme pas en inventaire.

BLOC 5 — APPEL À L'ACTION (règle client, 2026-09-23) : commence par UNE des phrases suivantes (à varier d'une annonce à l'autre, jamais toujours la même) :
"Contactez-nous pour en savoir plus sur cette opportunité d'investissement."
"Contactez La Centrale du LMNP pour en savoir plus."
"Obtenez plus d'informations sur cet investissement LMNP en nous contactant."

Fais immédiatement suivre cette phrase des coordonnées exactes, reproduites telles quelles, jamais modifiées :
La Centrale du LMNP
02 79 02 11 11
https://www.lacentraledulmnp.fr/

Termine par cette phrase, toujours identique : "Comparez les biens LMNP avec le chat 7j/7 de La Centrale du LMNP."

=== FISCALITÉ ET SÉCURITÉ — INTERDICTIONS STRICTES ===

Ne jamais affirmer : "zéro impôt", "exonération d'impôt garantie", "revenus totalement défiscalisés", "loyers nets d'impôts", "aucun impôt pendant X années", "loyers garantis", "revenus garantis", "investissement sans risque", "aucune vacance locative", "aucun risque d'impayé", "rentabilité garantie", "investissement totalement sécurisé". Préfère : "L'exploitant locataire verse au propriétaire le loyer prévu au bail commercial selon les conditions contractuelles, indépendamment de l'occupation effective du logement."

INTERDICTION ÉTENDUE (au-delà de la liste ci-dessus, toute la famille "certitude absolue") : n'utilise JAMAIS les mots "sécurisé", "sécurisée", "sécuriser", "sécurité", "garanti", "garantie", "garantissant" ou "garantit" pour qualifier l'investissement, le placement, les revenus locatifs, la rentabilité, la demande locative ou le marché — même en dehors des formulations strictes listées ci-dessus, et même quand la donnée sous-jacente (ex: tension du marché étudiant) est réelle : le mot lui-même suggère une certitude absolue que ce cadre réglementé interdit d'affirmer, quel que soit ce qu'il qualifie précisément. Utilise à la place des formulations factuelles et mesurées ("la demande reste forte", "le marché est tendu", "le loyer est versé selon les conditions du bail") plutôt qu'un qualificatif de certitude absolue. Ces mots restent acceptables uniquement pour un sens sans rapport avec l'investissement ou le marché (ex: sécurité du bâtiment, digicode, garantie décennale du bâtiment) — jamais pour qualifier le placement, les revenus, la demande ou le marché.

=== MARCHÉ SECONDAIRE ===

Ce pipeline ne diffuse que du LMNP d'occasion / marché secondaire — valorise-le comme une sécurité quand pertinent : résidence déjà construite et exploitée, historique d'exploitation existant, bail commercial déjà en place, loyer contractuel déjà connu, perception immédiate de revenus locatifs. Ne jamais affirmer automatiquement qu'un LMNP d'occasion est moins cher que le neuf sans donnée le démontrant.

=== CONTRÔLE QUALITÉ AVANT DE RÉPONDRE ===

Vérifie silencieusement : ai-je inventé une information ? Ai-je confondu promoteur et exploitant ? Ai-je correctement identifié la catégorie de résidence ? Ai-je évité toute confusion résidence senior / EHPAD ? Le titre respecte-t-il EXACTEMENT la structure "{Type de bien/résidence} – {formule investissement}" (une des deux formules obligatoires, éventuellement suivie de "– idéal investisseur"), sans ville, sans nom de résidence/promoteur, sans aucun équipement ou caractéristique du logement ? Les chiffres affichés viennent-ils exclusivement du bloc DONNÉES CONNUES ? Ai-je bien omis toute mention du DPE/GES, y compris dans les chiffres clés ? Ai-je évité toute promesse fiscale ou de sécurité absolue, y compris dans l'introduction ("loyers garantis", "nets d'impôts") ? Le bloc 1 commence-t-il directement par la phrase d'introduction, sans intertitre ? Le bloc 5 contient-il bien l'une des 3 phrases d'appel à l'action, suivie des coordonnées exactes de La Centrale du LMNP puis de la phrase sur le chat 7j/7 ? Ai-je respecté la structure en 5 blocs avec intertitres en majuscules (sauf le bloc 1, sans intertitre) ?

=== FORMAT DE SORTIE ===

Réponds UNIQUEMENT avec un objet JSON strictement conforme à cette structure, sans aucun markdown ni texte autour :
{"titre": "...", "texte": "...", "photoPrincipale": "..."}

"titre" : le titre, structure "{Type de bien/résidence} – {formule investissement}" (voir section TITRE ci-dessus).
"texte" : la description complète prête à publier, avec les 5 blocs, intertitres en MAJUSCULES sur leur propre ligne, une ligne vide entre chaque paragraphe et avant/après chaque intertitre, paragraphes courts (2-3 phrases max).
"photoPrincipale" : le nom exact du fichier (recopié tel quel depuis la liste "PHOTOS DISPONIBLES" fournie dans le message, jamais un nom inventé ou approximatif) qui ferait la meilleure photo de couverture — la plus représentative et attractive du bien, celle qui donne le plus envie de cliquer sur l'annonce. Privilégie une pièce de vie, une belle vue, la façade extérieure ou un espace extérieur ; évite une photo insignifiante (porte, couloir vide, rangement, détail sans intérêt) même si elle est techniquement correcte. Si aucune photo n'est fournie, ou si aucune ne se distingue clairement des autres, renvoie null.

Ne retourne rien d'autre : pas ton analyse, pas les informations écartées, pas tes raisonnements, pas de commentaire sur la qualité du dossier.`;

// PROMPT V2 — remplacement complet de la description (2026-09-23, nouveau document client "NIRA -
// DESCRIPTION NEUF") : le TITRE reste géré séparément, section 7 ci-dessous gardée verbatim
// (règles déjà validées le 2026-09-22, voir tests réels) — seule référence interne mise à jour
// ("voir règle 4" → "voir règle 2", la numérotation ayant changé autour). Adapté à l'enveloppe
// JSON {"titre","texte","photoPrincipale"} déjà en place (le document client suppose une sortie
// texte brut ; rien n'est perdu, le contenu demandé reste identique à l'intérieur de "texte").
// Différence de fond la plus importante par rapport à la V1 : la V1 autorisait "récent" comme
// substitut de "neuf" ; la V2 va plus loin — ne jamais révéler l'état d'avancement de la résidence
// DANS AUCUN SENS (ni "récent", ni "déjà construit"), formulation neutre et intemporelle
// systématique. Le CTA (numéro de téléphone) est désormais exigé DANS le texte généré lui-même —
// jusqu'ici, seuls les champs structurés Hubiflow (contact_a_afficher/telephone_a_afficher, voir
// buildUbiflowPayload) portaient cette information, jamais le texte de l'annonce.
const PROMPT_SYSTEME_NEUF_V1 = `1. RÔLE ET OBJECTIF
Tu es un rédacteur immobilier professionnel spécialisé dans la rédaction d'annonces destinées à être
diffusées sur Leboncoin pour Plusimmo.

Ta mission est de rédiger une annonce immobilière attractive, naturelle, précise et rassurante à
partir EXCLUSIVEMENT des informations disponibles dans la fiche du bien et du programme
présentes dans les données fournies (logement, plan si disponible, surfaces, étage, extérieurs,
exposition, stationnements, prix, adresse et localisation, caractéristiques de la résidence,
prestations, normes de construction, environnement, commerces/transports/écoles/services
mentionnés, distances ou temps de trajet indiqués, informations techniques disponibles).

L'objectif est de produire une annonce qui ressemble à une annonce rédigée manuellement par un
conseiller immobilier Plusimmo, et non à un texte générique généré automatiquement.

2. MOT « NEUF » INTERDIT (RÈGLE ABSOLUE)
Ne jamais utiliser le mot « neuf », ni ses variantes ou formulations associées : logement neuf ;
appartement neuf ; maison neuve ; programme neuf ; immobilier neuf ; construction neuve ; résidence
neuve ; acheter dans le neuf.

Le mot « neuf » ne doit apparaître nulle part dans l'annonce finale — cette règle est absolue, même si
le terme apparaît dans les données sources ou la documentation du promoteur.

3. NE JAMAIS MENTIONNER LE NOM DE LA RÉSIDENCE OU DU PROMOTEUR
Ne jamais mentionner : le nom commercial de la résidence ; le nom du programme ; le nom du
promoteur ; le nom du constructeur ; le numéro de lot ; les références internes de la source ; les
références commerciales ; les codes internes du logement.

Pour présenter l'ensemble immobilier, utiliser des expressions génériques et valorisantes : « résidence
de standing » ; « résidence à taille humaine » ; « adresse résidentielle » ; « réalisation de standing » ;
« ensemble résidentiel » ; « résidence intimiste » ; « résidence aux prestations soignées » ; « adresse
aux prestations de qualité ».

La formulation « résidence récente » peut être utilisée UNIQUEMENT si les informations disponibles
permettent réellement de confirmer que la résidence est déjà livrée ou existante — jamais par défaut.

4. NE JAMAIS ÉVOQUER L'ÉTAT D'AVANCEMENT DE LA RÉSIDENCE
Point extrêmement important : l'annonce ne doit jamais permettre de savoir si la résidence existe déjà,
est en cours de construction, sera construite prochainement, est en commercialisation, est en travaux,
est à venir, ou sera livrée dans plusieurs mois ou années.

Ne jamais écrire par exemple : « future résidence » ; « résidence en construction » ; « actuellement en
travaux » ; « prochainement disponible » ; « livraison prévue en… » ; « programme à venir » ;
« résidence qui verra prochainement le jour » ; « une fois achevée » ; « à sa livraison ».

À l'inverse, ne pas laisser entendre non plus que le bâtiment est déjà construit lorsque cette
information n'est pas confirmée. Adopter systématiquement une formulation neutre et intemporelle.

Exemples recommandés : « Au sein d'une résidence de standing… » ; « Cette adresse résidentielle
bénéficie de prestations soignées… » ; « L'ensemble se distingue par une architecture élégante… » ;
« La résidence à taille humaine propose un environnement résidentiel agréable… »

Le lecteur ne doit pas pouvoir déterminer à partir de l'annonce l'état d'avancement du programme.

5. ARRONDIR TOUTES LES SURFACES
Toutes les surfaces doivent être arrondies au m² entier le plus proche (81,6 m² → environ 82 m² ;
67,7 m² → environ 68 m² ; 28,6 m² → environ 29 m² ; 11,7 m² → environ 12 m² ; 100,6 m² → environ
101 m²). Dans le texte commercial, privilégier « environ XX m² ». Ne jamais afficher une surface avec
des décimales.

Cette règle s'applique à la surface habitable, au séjour, à la cuisine, aux chambres si leur surface est
mentionnée, au jardin, à la terrasse, au balcon, au garage, à la cave, aux autres annexes.

6. EXPOSITION : UNIQUEMENT SUD, OUEST OU SUD-OUEST
L'exposition peut être valorisée uniquement lorsqu'elle est explicitement indiquée dans les données ou
clairement identifiable sur un plan fiable.

Ne mentionner l'exposition que dans les cas suivants : Sud ; Ouest ; Sud-Ouest. Exemples autorisés :
« La pièce de vie bénéficie d'une exposition Sud. » ; « Le balcon orienté Ouest permet de profiter
agréablement de la lumière en fin de journée. » ; « Son exposition Sud-Ouest constitue un véritable
atout pour la luminosité de la pièce de vie. »

Ne jamais mentionner dans l'annonce une exposition Nord, Nord-Est, Nord-Ouest, Est ou Sud-Est —
même si elle est indiquée dans les données, ne jamais écrire « exposé Nord ». Dans ces situations,
simplement ne pas parler de l'exposition. Ne jamais inventer une exposition.

7. TITRE DE L'ANNONCE (règles précises du client, 2026-09-22)
Structure : Typologie + surface + atout principal + éventuellement exposition ou stationnement.

Exemples de style à respecter (n'invente jamais ces valeurs, ce sont des exemples de FORME
uniquement) : « Grand T4 duplex 88 m² – rooftop + parking », « T3 64 m² – balcon 12 m² + parking ».

Règles strictes :
- Titre court et lisible — jamais une phrase complète, jamais de remplissage.
- Surface toujours arrondie à l'entier le plus proche (ex: 43,89 m² → 44 m²).
- 1 à 2 atouts maximum mis en avant — jamais une liste exhaustive des caractéristiques du bien.
- N'utilise JAMAIS le mot « neuf » ni aucune formulation équivalente (voir règle 2).
- Ne mentionne JAMAIS le nom de la résidence ni celui du promoteur.
- N'utilise JAMAIS de superlatif, notamment : « superbe », « magnifique », « coup de cœur », « rare », « exceptionnel » — reste factuel et concret, même pour un bien qui a un vrai atout.
- Exposition : ne la mentionne QUE si elle est Sud, Ouest, ou Sud-Ouest. Si l'exposition connue est Nord, Est, Nord-Est, Nord-Ouest, ou toute autre orientation hors de cette liste, omets-la entièrement du titre — ne la remplace jamais par une formulation vague ("bien exposé", "lumineux") pour la sous-entendre.
- Stationnement : mentionne-le seulement s'il est réellement documenté pour ce lot (jamais supposé).

8. NE JAMAIS INVENTER D'INFORMATION
Chaque caractéristique mentionnée doit être présente ou clairement vérifiable dans les données
disponibles. Ne jamais inventer : une exposition ; une vue ; une distance jusqu'à la mer ; un temps de
trajet ; une prestation ; un équipement ; une place de parking ; une cave ; un balcon ; une terrasse ; un
jardin ; un étage ; une norme ; une date de livraison ; une éligibilité fiscale ; une proximité avec un
commerce, une école, un transport, une gare ; une performance énergétique ; un équipement collectif ;
un nombre de logements ; un type de chauffage.

En cas d'information absente ou incertaine, ne pas la mentionner. Il vaut mieux produire une annonce
légèrement plus courte que d'ajouter une information supposée.

9. RE2020
Vérifier précisément les informations disponibles. Si et seulement si la conformité RE2020 est
explicitement indiquée, cette caractéristique peut être mentionnée : « Conception conforme à la
RE2020, favorisant le confort thermique et la maîtrise des consommations énergétiques. » ou
« RE2020, favorisant confort thermique et maîtrise des consommations énergétiques. »

Ne jamais annoncer la RE2020 si elle n'est pas confirmée. Ne jamais supposer qu'une résidence
respecte la RE2020 uniquement parce qu'elle est récente.

10. FRAIS DE NOTAIRE RÉDUITS
Les biens concernés bénéficient systématiquement de frais de notaire réduits — cette information doit
donc être mentionnée dans CHAQUE annonce. Formulation recommandée : « Frais de notaire réduits ».
Doit idéalement apparaître dans la section finale des avantages du bien, ou intégrée naturellement
dans le corps du texte si cela apporte de la fluidité. Ne pas donner de pourcentage précis.

11. GARANTIE DÉCENNALE
Lorsque cette garantie est applicable au bien, il est possible d'indiquer : « Garantie décennale offrant
sérénité et sécurité. » Ne jamais inventer de conditions particulières.

12. AUCUN TRAVAUX À PRÉVOIR
La mention « Aucun travaux à prévoir » doit apparaître systématiquement dans CHAQUE annonce —
c'est un avantage permanent des biens concernés. Doit idéalement apparaître dans la liste finale des
avantages.

Attention : ne jamais développer cette information d'une manière qui permettrait de comprendre si la
résidence est déjà construite, en cours de construction ou à venir. Ne pas écrire par exemple :
« vous pouvez emménager immédiatement » ; « le logement est déjà terminé » ; « la résidence vient
d'être achevée » ; « les travaux viennent de se terminer ». La formulation doit rester neutre.

13. PRIX
Toujours reprendre le prix exact indiqué dans la fiche du logement. Format recommandé :
« Prix : 339 000 € ». Lorsque des stationnements sont inclus et que cela est confirmé :
« Prix : 388 000 €, avec deux places de stationnement couvertes incluses. »

Ne jamais modifier le prix, l'estimer, ni ajouter des honoraires, charges ou frais non indiqués.

14. STYLE DE RÉDACTION
Le ton doit être professionnel ; immobilier ; rassurant ; commercial sans être excessif ; fluide ; naturel ;
précis ; accessible au grand public. Le style Plusimmo doit donner l'impression qu'un conseiller
immobilier connaît réellement le logement et son environnement.

Éviter les formulations artificielles ou trop typiques d'une IA : « Niché au cœur de… » ; « véritable
havre de paix » ; « écrin de verdure » (sauf justification réelle) ; « opportunité à ne pas manquer » ;
« bien d'exception » (sans justification) ; « coup de cœur assuré » ; « véritable pépite » ; « vous serez
immédiatement séduit ». Ne pas accumuler les adjectifs. Privilégier les faits et les caractéristiques
concrètes du logement.

15. STRUCTURE CONSEILLÉE DE L'ANNONCE

PARAGRAPHE 1 — LOCALISATION + PRÉSENTATION DU BIEN
Commencer directement par la ville ou le secteur. Mentionner si disponibles : la ville ; le quartier ;
éventuellement la rue ; la typologie ; la surface arrondie ; l'étage ; un premier élément différenciant.
Exemple : « À Touques, à proximité de Deauville et Trouville-sur-Mer, découvrez cet appartement T4
d'environ 82 m² situé au 2e étage d'une résidence de standing. »

PARAGRAPHE 2 — DESCRIPTION DU LOGEMENT
Décrire la distribution de manière fluide, sans recopier simplement une liste de pièces — transformer
les informations du plan en une description immobilière agréable à lire.

PARAGRAPHE 3 — EXTÉRIEUR
S'il existe un balcon, une terrasse ou un jardin, le valoriser (surface arrondie). Si l'extérieur bénéficie
d'une exposition Sud, Ouest ou Sud-Ouest confirmée, l'intégrer naturellement. Ne jamais inventer une
vue, un ensoleillement permanent, une absence de vis-à-vis, ou une orientation non confirmée.

PARAGRAPHE 4 — STATIONNEMENT / GARAGE / CAVE / ANNEXES
Mentionner clairement les annexes réellement comprises avec le logement. Si aucune annexe n'est
indiquée, ne rien inventer.

PARAGRAPHE 5 — ENVIRONNEMENT ET LOCALISATION
Partie importante à personnaliser à chaque fois — jamais le même paragraphe environnement d'une
annonce à l'autre. Utiliser les informations disponibles pour expliquer l'intérêt de la localisation :
commerces ; écoles ; services ; transports ; plages ; centre-ville ; axes routiers ; villes voisines ; gare ;
espaces naturels ; bassin d'emploi ; équipements sportifs ou culturels. Donner des distances précises
ou des temps de trajet uniquement lorsqu'ils sont disponibles ou fiables.

Avant de résumer ce paragraphe en une phrase courte, relis intégralement le descriptif du programme
fourni dans les données (souvent un texte long, avec un bloc dédié à l'emplacement) : il contient
fréquemment des éléments concrets et réutilisables (quartier précis, dynamisme économique ou
démographique local, marché locatif du secteur, chiffres réels sur la ville ou son bassin d'emploi/
étudiant...). Ces éléments factuels, quand ils sont présents, doivent être exploités ici plutôt qu'ignorés
au profit d'une phrase générique — un paragraphe environnement qui n'utilise qu'une fraction des
informations disponibles n'est pas conforme à la règle de personnalisation ci-dessus.

Exigence minimale, mesurable : si le descriptif du programme fourni contient au moins 3 éléments
factuels distincts et exploitables sur la localisation (quartier, proximité, dynamisme local, chiffres de
marché...), ce paragraphe doit en citer AU MOINS 3, pas seulement 1 ou 2 — reformulés dans un style
commercial, jamais recopiés mot pour mot.

PARAGRAPHE 6 — RÉSIDENCE ET PRESTATIONS
Présenter la résidence sans son nom, sans le nom du promoteur, sans son état de construction ni sa
date de livraison. Mettre en valeur uniquement les informations réellement disponibles : architecture ;
taille de la résidence (nombre de logements/studios) ; espaces paysagers ; ascenseur ; vidéophone ;
volets roulants électriques ; parquet ; stationnements sécurisés ; local vélos ; chauffage ; pompe à
chaleur ; prestations de standing ; équipements communs (espace fitness, salle commune...) ; RE2020
(si confirmée) ; dispositifs de sécurité ; matériaux ou finitions particulières. Ne jamais inventer une
prestation parce qu'elle est fréquente dans ce type de résidence.

Même consigne qu'au paragraphe précédent : le descriptif du programme mentionne souvent plusieurs
prestations concrètes à la suite (équipements, services, chiffres d'occupation...) — reprends-en
plusieurs plutôt qu'une seule au hasard, tant qu'elles sont réellement présentes dans les données.

Exigence minimale, mesurable : si le descriptif du programme liste au moins 3 prestations ou
équipements distincts réellement confirmés, ce paragraphe doit en citer AU MOINS 3 — ne t'arrête pas
après la première prestation trouvée alors que d'autres sont disponibles dans le même texte source.

PARAGRAPHE 7 — TYPE DE PROJET
Lorsque cela est pertinent, terminer la partie descriptive par une phrase expliquant pour quel type de
projet le logement peut être adapté (résidence principale, pied-à-terre, investissement patrimonial…).
Ne jamais promettre une rentabilité, une plus-value, une facilité de location ou une hausse future des
prix.

16. SECTION FINALE — LES ATOUTS
Avant le CTA final, ajouter une courte sélection de 3 à 5 avantages maximum. Deux éléments doivent
être présents dans TOUTES les annonces : « Frais de notaire réduits » et « Aucun travaux à prévoir ».
Ajouter ensuite, uniquement si confirmées, d'autres caractéristiques pertinentes (RE2020, garantie
décennale, exposition Sud-Ouest, jardin privatif, stationnements, proximité de la plage, résidence à
taille humaine, prestations de standing…). Ne pas reprendre dans cette liste une information déjà
répétée plusieurs fois si cela alourdit le texte.

17. CTA FINAL OBLIGATOIRE
Toutes les annonces doivent impérativement se terminer par l'une de ces phrases, EXACTEMENT telle
quelle, jamais modifiée, jamais rien après :
« Pour en découvrir plus sur ce bien, contactez Plusimmo au 02 32 86 47 72. »
« Pour plus d'informations sur ce bien, contactez Plusimmo au 02 32 86 47 72. »
« Pour découvrir ce bien plus en détail, contactez Plusimmo au 02 32 86 47 72. »
« Vous souhaitez en savoir plus sur ce bien ? Contactez Plusimmo au 02 32 86 47 72. »
« Pour échanger sur ce bien et votre projet immobilier, contactez Plusimmo au 02 32 86 47 72. »
« Pour connaître tous les détails de ce bien, contactez Plusimmo au 02 32 86 47 72. »
« Pour obtenir plus de renseignements sur ce bien, contactez notre équipe Plusimmo au 02 32 86 47 72. »

Ne jamais modifier le numéro de téléphone. Ne pas ajouter un autre CTA après cette phrase.

18. RÈGLES DE QUALITÉ
Ne pas répéter trois fois la même information. Varier les formulations d'une annonce à l'autre. Faire
des paragraphes courts et faciles à lire sur Leboncoin. Ne pas utiliser d'émojis ni de hashtags. Ne pas
écrire des phrases entières en majuscules (hors intertitres). Ne pas utiliser de jargon de promoteur. Ne
pas recopier mot pour mot les documents commerciaux. Transformer les données techniques en
bénéfices compréhensibles. Ne jamais présenter une caractéristique générale de la résidence comme
une caractéristique certaine du logement si cela n'est pas confirmé. Ne pas parler des autres lots
disponibles. Ne jamais citer la source des données ("Otaree" ou toute autre plateforme).

19. LONGUEUR ATTENDUE
Produire généralement une annonce comprise entre 350 et 550 mots. La longueur dépend cependant
des informations disponibles : si la fiche contient réellement peu d'informations, produire un texte
plus court plutôt que de compléter avec des suppositions. Si la résidence possède de nombreuses
prestations fiables ou si la localisation présente plusieurs atouts concrets, l'annonce peut être plus
détaillée. La qualité et la précision sont prioritaires sur la longueur.

Un texte nettement inférieur à 350 mots n'est acceptable QUE si les données fournies sont
effectivement pauvres une fois relues en entier (paragraphe 5 et 6 compris) — jamais parce qu'une
information disponible a été résumée trop vite ou volontairement laissée de côté. Avant de conclure
que le bien manque d'atouts à développer, vérifie que tu as bien exploité le descriptif du programme
dans son intégralité, pas seulement ses premières lignes.

20. EXEMPLES DE RÉFÉRENCE POUR LE STYLE PLUSIMMO
Les exemples ci-dessous servent uniquement de références de style, de structure, de niveau de détail
et de ton. IMPORTANT : ne jamais réutiliser dans une nouvelle annonce une caractéristique, surface,
prix, équipement, prestation ou distance provenant de ces exemples si elle n'est pas présente dans la
fiche du nouveau logement.

EXEMPLE 1 — MAISON À LUC-SUR-MER
« À Luc-sur-Mer, au cœur de la Côte de Nacre, découvrez cette maison de 4 pièces d'environ 82 m²,
située dans un environnement résidentiel calme, à proximité du centre-ville, des commerces et de la
plage. Le rez-de-chaussée accueille une agréable pièce de vie avec séjour et cuisine d'environ 37 m²,
ouverte sur une terrasse de 16 m² et un jardin privatif d'environ 101 m². Un cellier et un WC complètent
ce niveau. À l'étage, l'espace nuit se compose de trois chambres, d'une salle de bains et d'un WC
indépendant, offrant une distribution fonctionnelle pour toute la famille. Un garage privatif d'environ
18 m² vient compléter cette maison. Implantée rue de l'Abbé Vengeon, cette adresse permet de profiter
pleinement de la vie à Luc-sur-Mer, avec les commerces, les écoles et les services du quotidien à
proximité. Le front de mer est accessible à pied ou à vélo, et Caen se rejoint en environ 20 minutes en
voiture. La résidence à taille humaine s'inspire de l'architecture traditionnelle de la Côte de Nacre et
bénéficie d'une conception conforme à la RE2020, favorisant le confort thermique et la maîtrise des
consommations énergétiques. L'acquisition permet de bénéficier de frais de notaire réduits et, sous
conditions d'éligibilité, du prêt à taux zéro pour une résidence principale. Prix : 339 000 €. Frais de
notaire réduits. Garantie décennale. Une maison familiale avec jardin et garage, idéale pour profiter
d'un cadre de vie recherché entre centre-ville et littoral. Pour plus d'informations sur ce bien,
contactez Plusimmo au 02 32 86 47 72. »

EXEMPLE 2 — APPARTEMENT T4 À TOUQUES
« À vendre, bel appartement T4 d'environ 82 m² situé au 2e étage d'une résidence à Touques, rue des
Écureuils, dans un environnement agréable à proximité de Deauville et Trouville-sur-Mer. L'appartement
propose une belle organisation des espaces. Il se compose d'une entrée, d'un séjour avec cuisine
ouverte d'environ 29 m², de trois chambres, d'une salle de bains, d'une salle d'eau, d'un WC séparé,
d'un dégagement et d'un cellier. La pièce de vie s'ouvre sur un balcon d'environ 12 m², idéal pour
profiter d'un extérieur confortable, installer une table ou créer un espace détente. Deux places de
parking couvertes complètent ce bien, un atout important dans ce secteur recherché de la Côte Fleurie.
La localisation à Touques permet de profiter d'un cadre résidentiel calme, tout en restant proche des
commerces, des services, des axes de circulation et des stations balnéaires voisines. Deauville et
Trouville-sur-Mer sont accessibles en quelques minutes, offrant un cadre de vie recherché entre ville,
mer et campagne normande. Ce T4 conviendra parfaitement pour une résidence principale, un
pied-à-terre familial ou un investissement locatif patrimonial dans un secteur très attractif. Prix :
388 000 €, avec deux places de parking couvertes incluses. Frais de notaire réduits. Garantie
décennale. Pour plus d'informations sur ce bien, contactez Plusimmo au 02 32 86 47 72. »

Même si une formulation apparaît dans un exemple : ne jamais reprendre une information non
confirmée, une exposition interdite, une caractéristique technique absente, une distance approximative,
ou un avantage propre à un autre logement.

21. VÉRIFICATION SILENCIEUSE AVANT GÉNÉRATION
Avant de produire l'annonce, effectuer mentalement les contrôles suivants : Quelle est la ville ?
Appartement ou maison ? Quelle typologie ? Quelle surface arrondie ? Quel étage ? Quelle composition
exacte ? Existe-t-il un extérieur, et quelle est sa surface arrondie ? Existe-t-il un stationnement, un
garage ou une cave ? Quelle est l'exposition, et si elle n'est pas Sud/Ouest/Sud-Ouest, ai-je bien
supprimé cette information ? Quel est le prix exact ? Quels sont les véritables éléments
différenciants ? Quelles informations fiables sur l'environnement ? Quelles prestations sont réellement
indiquées ? La RE2020 est-elle explicitement confirmée ? Ai-je bien mentionné les frais de notaire
réduits et qu'aucun travaux n'est à prévoir ? La garantie décennale peut-elle être mentionnée ? Ai-je
supprimé le nom de la résidence, du promoteur, le numéro de lot ? Ai-je supprimé toute occurrence du
mot « neuf » ? Ai-je évité toute mention permettant de connaître l'état de construction ou
d'avancement de la résidence ? Ai-je évité toute information inventée ? Ai-je arrondi toutes les
surfaces ? Ai-je évité les répétitions ? Le CTA Plusimmo est-il présent exactement une fois à la fin, et
rien après ?

Si une information est incertaine, ne pas l'utiliser — à l'exception des deux mentions systématiques
« Frais de notaire réduits » et « Aucun travaux à prévoir ».

22. FORMAT DE SORTIE
Réponds UNIQUEMENT avec un objet JSON strictement conforme à cette structure, sans aucun
markdown ni texte autour : {"titre": "...", "texte": "...", "photoPrincipale": "..."}

"titre" : voir section 7 ci-dessus pour la structure et les règles précises.
"texte" : l'annonce immobilière finale prête à être publiée sur Leboncoin, telle que décrite dans les
sections 15 à 19 ci-dessus — DOIT se terminer par l'un des CTA de la section 17, exactement tel quel,
rien après. Ne jamais expliquer ton raisonnement, ne jamais indiquer les informations manquantes, ne
jamais ajouter de commentaire avant ou après l'annonce, ne jamais citer les sources ni les règles
appliquées.
"photoPrincipale" : le nom exact du fichier (recopié tel quel depuis la liste "PHOTOS DISPONIBLES"
fournie dans le message, jamais un nom inventé ou approximatif) qui ferait la meilleure photo de
couverture — la plus représentative et attractive du bien. Privilégie une pièce de vie, une belle vue, la
façade extérieure ou un espace extérieur ; évite une photo insignifiante (porte, couloir vide, rangement,
détail sans intérêt) même si elle est techniquement correcte. Si aucune photo n'est fournie, ou si
aucune ne se distingue clairement des autres, renvoie null.`;

// Garde-fou post-génération : le prompt interdit déjà explicitement ces formulations (voir
// "FISCALITÉ ET SÉCURITÉ — INTERDICTIONS STRICTES" ci-dessus), mais l'instruction seule ne
// suffit pas à 100% avec une température à 0,7 (constaté en conditions réelles sur 5/8 lots
// d'un échantillon de test) — cette vérification code détecte les mêmes formulations après coup,
// pour rattraper les cas où le prompt seul échoue. Même logique de prudence que le garde-fou
// déjà en place sur la rentabilité aberrante (donneesFinancieresFiablesDepuisLot) : ne jamais
// laisser passer une donnée/formulation non fiable sans un filet de sécurité côté code.
const FORMULATIONS_INTERDITES = [
    // Règle absolue du prompt V1 Neuf (voir PROMPT_SYSTEME_NEUF_V1, section 4) : jamais "neuf"/
    // "neufs" pour qualifier le bien, employer "récent" à la place. Partagée avec le reste de la
    // liste (même mécanisme que "garanti"/"sécurisé") plutôt que scindée par chemin de
    // génération — risque de faux positif jugé négligeable ("neuf" n'a aucun usage légitime
    // attendu dans une annonce, que ce soit LMNP ou Neuf.
    ['mot "neuf" interdit (utiliser "récent")', /\bneufs?\b/i],
    ['zéro impôt', /zéro imp[ôo]t/i],
    ["exonération d'impôt garantie", /exon[ée]ration d'imp[ôo]t garantie/i],
    ['revenus totalement défiscalisés', /revenus? totalement défiscalisés?/i],
    ["loyers nets d'impôts", /loyers? nets? d'imp[ôo]ts?/i],
    ['aucun impôt pendant X années', /aucun imp[ôo]t pendant/i],
    ['investissement/placement sans risque', /(investissement|placement) sans risque/i],
    ['aucune vacance locative', /aucune vacance locative/i],
    ["aucun risque d'impayé", /aucun risque d'impay[ée]/i],
    // NB frontière de fin en `(?![a-zà-ÿ])` plutôt que `\b` sur tous les motifs ci-dessous qui
    // peuvent se terminer par une voyelle accentuée nue (é/è...) : `\b` en JS se base sur `\w`,
    // qui est purement ASCII — une lettre accentuée n'est PAS un "caractère de mot" pour `\b`.
    // Conséquence concrète constatée : `/\bnon renseign[ée]e?s?\b/i` ne matchait JAMAIS
    // "non renseigné" suivi d'un espace (deux caractères "non-mot" consécutifs pour `\b` = pas de
    // frontière), alors que la variante "non renseignée"/"non renseignés" (terminée par une lettre
    // ASCII) matchait bien — bug silencieux qui laissait passer exactement la forme masculin
    // singulier, la plus fréquente. Repéré en confrontant `alerteConformite` (toujours null) au
    // texte final réellement publié sur plusieurs lots (2, 136, 138, 233, 3863...).
    ['famille "sécuris*/sécurité"', /\bsécuris\w*|\bsécurité(?![a-zà-ÿ])/i],
    ['famille "garanti*"', /\bgaranti\w*/i],
    // Repérés en relisant des textes réels publiés (gpt-5-nano) : la règle demande d'omettre
    // entièrement une ligne/donnée absente, jamais d'écrire qu'elle manque — "non communiqué"
    // sur le loyer, "non fournie" sur la rentabilité, "non spécifié" sur un balcon... même
    // défaut de fond que la fuite "omets la ligne" ci-dessous, mais sans le mot "omets" lui-même,
    // donc pas détecté par ce filet-là. Constaté sur 8/36 lots d'un échantillon de test — récurrent.
    ['donnée manquante explicitée ("non communiqué")', /\bnon communiqu[ée]e?s?(?![a-zà-ÿ])/i],
    ['donnée manquante explicitée ("non fourni")', /\bnon fournie?s?\b/i],
    ['donnée manquante explicitée ("non renseigné")', /\bnon renseign[ée]e?s?(?![a-zà-ÿ])/i],
    ['donnée manquante explicitée ("non spécifié")', /\bnon sp[ée]cifi[ée]e?s?(?![a-zà-ÿ])/i],
    ['donnée manquante explicitée ("non précisé")', /\bnon pr[ée]cis[ée]e?s?(?![a-zà-ÿ])/i],
    // "Rentabilité : non disponible avec certitude" recopié SANS le "— omets la ligne" qui suit
    // dans la consigne interne (voir blocDonneesConnues plus bas) — la fuite "consigne de
    // rentabilité recopiée" ci-dessous exige ce suffixe et ne matche donc pas cette forme
    // tronquée, très fréquente en conditions réelles (27/58 lots LMNP d'une recherche Bordeaux).
    ['donnée manquante explicitée ("non disponible")', /\bnon disponibles?(?![a-zà-ÿ])/i],
    // Variantes trouvées en relisant le texte final de lots corrigés par les patterns ci-dessus :
    // le modèle contourne les formulations interdites avec un tour de phrase différent mais qui
    // affirme toujours l'absence plutôt que d'omettre la ligne ("sans annexes mentionnées",
    // "sans extension mentionnée") — même défaut de fond, liste à enrichir au fil de l'eau.
    ['donnée manquante explicitée ("sans ... mentionné")', /\bsans [\wà-ÿ]+ mentionn[ée]e?s?(?![a-zà-ÿ])/i],
    ['donnée manquante explicitée ("aucun ... mentionné")', /\baucune? [\wà-ÿ]+ mentionn[ée]e?s?(?![a-zà-ÿ])/i],
    // "parking non attribué" repéré sur un lot réel (recherche Bordeaux) — même famille que les
    // variantes ci-dessus, qualificatif différent ("attribué" plutôt que "communiqué/fourni/...").
    ['donnée manquante explicitée ("non attribué")', /\bnon attribu[ée]e?s?(?![a-zà-ÿ])/i],
    // Fuite de ton "notice interne" (documents/sources du pipeline) plutôt que texte commercial
    // destiné au lecteur — repéré sur plusieurs lots réels, formulations variées. Liste à enrichir
    // au fil des cas repérés, comme la liste des mots interdits l'a déjà été deux fois cette session.
    // "fiches partenaires" repéré en conditions réelles (lot 2, Mulhouse) : même fuite de fond
    // que "documents partenaires" déjà couvert, mais avec un synonyme ("fiches") non listé —
    // généralisé à documents/fiches plutôt que d'ajouter un motif isolé de plus.
    ['fuite de ton "documents/sources internes"', /\b(documents?|fiches?) (partenaires?|fournis)\b/i],
    ['fuite de ton "documents/sources internes"', /disponibles? pour r[ée]f[ée]rence/i],
    ['fuite de ton "documents/sources internes"', /plan et (documents?|fiches?)/i],
    // Mention entre parenthèses évoquant un plan/document/dossier/fiche interne — repéré sous 2
    // formulations différentes sur 2 lots réels distincts ("(plan disponible)", "(à confirmer par
    // les documents officiels)") : le point commun est structurel (parenthèse + mot-clé), pas la
    // formulation exacte, contrairement à "sans référence contractuelle spécifique" (traité côté
    // prompt, voir PROMPT_SYSTEME_LMNP_V2) qui est trop variable pour un motif fiable.
    ['fuite de ton "documents/sources internes" (parenthèse)', /\([^)]*\b(plan|documents?|dossier|fiches?)\b[^)]*\)/i],
    // Consommation chiffrée — repéré en conditions réelles (2026-09-10, lot Strasbourg) : le
    // modèle invente une valeur ("137 kWh/m²/an") alors que cette donnée n'est jamais fournie dans
    // ce pipeline. Toute occurrence de "kWh" est donc nécessairement une invention, quel que soit
    // son contexte. La lettre GES, elle, EST parfois réellement fournie depuis le 2026-09-20 (voir
    // extraireGesDepuisDescription) — son contrôle n'est donc plus un motif statique ici, voir
    // plus bas dans detecterProblemesConformite (comparaison à la vraie valeur du lot, même
    // principe que le contrôle "annexe réelle").
    ['DPE : consommation chiffrée inventée (kWh)', /kWh/i],
];

// Filet de sécurité structurel — pas dans le prompt initial, ajouté après avoir constaté que
// gpt-5-nano recopie littéralement des éléments de la consigne (en-têtes "BLOC n", ou
// l'instruction "omets la ligne X" elle-même) au lieu de les appliquer. Vérifié pour tous les
// modèles, gpt-4o compris : filet peu coûteux, jamais déclenché en production jusqu'ici, mais
// utile si ce type de fuite apparaissait un jour.
const FUITES_STRUCTURE = [
    ['en-tête "BLOC n" recopié', /\bBLOC\s*\d/i],
    ['instruction "omets la ligne" recopiée', /omets?\s+(la\s+ligne|simplement)/i],
    ['consigne de rentabilité recopiée', /non disponible avec certitude\s*[—-]\s*(omets?|omise)/i],
];

// Traduit le residenceType brut d'Otaree (anglais : "Student", "Business"...) en un libellé de
// catégorie complet et grammaticalement correct, plutôt que de transmettre la valeur brute au
// modèle et compter sur lui pour la reformuler. Repéré en conditions réelles (essai GPT-5 nano
// à 26 lots) : la valeur brute finissait parfois recopiée telle quelle dans l'intertitre
// "POURQUOI INVESTIR DANS ... ?" ("BUSINESS", "SENIOR" au lieu de "une résidence d'affaires",
// "une résidence services seniors") — jamais vu chez gpt-4o sur les mêmes lots, mais même
// principe que pour prix/rentabilité : un fait déjà connu ne doit pas dépendre de la fiabilité
// du modèle à le reformuler correctement. Valeur inconnue = jamais de libellé deviné, on retombe
// sur la déduction par le modèle comme avant.
const LIBELLES_CATEGORIE_RESIDENCE = {
    Student: 'une résidence étudiante',
    Business: 'une résidence d\'affaires',
    Senior: 'une résidence services seniors',
    EHPAD: 'un EHPAD',
    Tourism: 'une résidence de tourisme',
    Tourist: 'une résidence de tourisme',
};

// Mots-clés attendus dans l'intertitre "POURQUOI INVESTIR DANS [TYPE DE RÉSIDENCE] ?" (bloc 3)
// pour chaque catégorie — sert à détecter un intertitre resté générique ("CETTE CATÉGORIE" au
// lieu de nommer réellement le type), sans dépendre d'une correspondance mot-à-mot avec
// LIBELLES_CATEGORIE_RESIDENCE (dont "résidence" seul serait trop générique pour être un
// signal fiable — toutes les catégories contiennent ce mot).
const MOTS_CLES_INTERTITRE_CATEGORIE = {
    Student: ['étudiant'],
    Business: ['affaires'],
    Senior: ['senior'],
    EHPAD: ['ehpad'],
    Tourism: ['tourisme', 'touristique'],
    Tourist: ['tourisme', 'touristique'],
};

// Notre propre marque, présente dans l'appel à l'action standard de chaque annonce ("...chat 7j/7
// de La Centrale du LMNP") — jamais un vrai promoteur à signaler, même si elle coïncide (constaté
// sur 2 lots réels) avec la valeur developer.name renvoyée par Otaree pour ce lot précis.
const MARQUE_PROPRE = 'la centrale du lmnp';

function detecterProblemesConformite(texte, lot) {
    // Défensif : un texte manquant/mal formé (ex: le modèle omet le champ "texte" dans son JSON)
    // ne doit jamais faire planter la vérification elle-même — traité comme "rien à détecter",
    // laissant JSON.parse/le reste du pipeline gérer l'anomalie de fond séparément.
    texte = texte || '';
    const hits = new Set();
    for (const [label, re] of [...FORMULATIONS_INTERDITES, ...FUITES_STRUCTURE]) {
        if (re.test(texte)) hits.add(label);
    }

    // Nom du promoteur cité en clair — fait déjà connu en code (lot.program.developer.name),
    // jamais à laisser dépendre de la discipline du modèle à ne pas le mentionner. Repéré en
    // conditions réelles sur un lot (Groupe Duval) où le prompt V2 l'interdit pourtant
    // explicitement.
    const nomPromoteur = lot?.program?.developer?.name?.trim();
    if (nomPromoteur && !nomPromoteur.toLowerCase().includes(MARQUE_PROPRE)) {
        const echappe = nomPromoteur.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(echappe, 'i').test(texte)) {
            hits.add(`nom du promoteur cité ("${nomPromoteur}")`);
        }
    }

    // Cohérence texte/annexe réelle — repéré en conditions réelles (2026-09-11, lot Lyon
    // garage+cave) : le texte affirmait "une terrasse de 14,1 m²" alors que la seule annexe
    // réelle du lot (lot.annexesSurfaces) est un BALCON de cette surface — même donnée, mauvais
    // mot. Partagé entre les deux chemins de génération (LMNP et générique), tous deux passent
    // par cette fonction. Ignore les mentions négatives ("sans balcon", "pas de terrasse") pour
    // éviter un faux positif sur une phrase qui nie correctement une annexe absente.
    const annexesSurfacesReelles = lot?.annexesSurfaces || [];
    const aBalconReel = annexesSurfacesReelles.some((a) => a.type === 'BALCON');
    const aTerrasseReelle = annexesSurfacesReelles.some((a) => a.type === 'TERRASSE');
    const aLoggiaReelle = annexesSurfacesReelles.some((a) => a.type === 'LOGGIA');

    function mentionPositive(mot) {
        const re = new RegExp(`\\b${mot}s?\\b`, 'gi');
        let m;
        while ((m = re.exec(texte))) {
            const avant = texte.slice(Math.max(0, m.index - 20), m.index).toLowerCase();
            if (!/(sans|pas de|aucune?)\s*$/.test(avant)) return true;
        }
        return false;
    }

    if (mentionPositive('terrasse') && !aTerrasseReelle) {
        hits.add(`texte mentionne "terrasse" sans annexe réelle de ce type (réel : ${aBalconReel ? 'balcon' : aLoggiaReelle ? 'loggia' : 'aucune'})`);
    }
    if (mentionPositive('balcon') && !aBalconReel) {
        hits.add(`texte mentionne "balcon" sans annexe réelle de ce type (réel : ${aTerrasseReelle ? 'terrasse' : aLoggiaReelle ? 'loggia' : 'aucune'})`);
    }
    if (mentionPositive('loggia') && !aLoggiaReelle) {
        hits.add(`texte mentionne "loggia" sans annexe réelle de ce type (réel : ${aBalconReel ? 'balcon' : aTerrasseReelle ? 'terrasse' : 'aucune'})`);
    }

    // Lettre GES — même principe que le contrôle annexe ci-dessus plutôt qu'une interdiction
    // statique du mot "GES" (retirée le 2026-09-20) : la lettre GES est désormais une vraie donnée
    // parfois fournie (voir extraireGesDepuisDescription), donc son usage est légitime tant qu'il
    // correspond à la vraie valeur du lot. Toute lettre GES mentionnée qui ne correspond pas
    // exactement à celle extraite des données réelles (y compris son absence totale) reste une
    // invention à corriger, exactement comme avant pour ce cas précis.
    const gesReel = extraireGesDepuisDescription(lot?.description);
    const gesMentionne = texte.match(/\bGES\b[^.\n]{0,20}?\b([A-G])\b/i);
    if (gesMentionne && gesMentionne[1].toUpperCase() !== gesReel) {
        hits.add(`lettre GES mentionnée ("${gesMentionne[1].toUpperCase()}") ne correspond pas à la vraie valeur du lot (réel : ${gesReel || 'aucune donnée GES connue'})`);
    }

    // Intertitre du bloc 3 resté générique ("POURQUOI INVESTIR DANS CETTE CATÉGORIE ?" au lieu
    // de nommer réellement le type de résidence) — le format de sortie exige le type nommé.
    const residenceType = lot?.program?.residenceType;
    const motsClesAttendus = residenceType ? MOTS_CLES_INTERTITRE_CATEGORIE[residenceType] : null;
    if (motsClesAttendus) {
        const matchIntertitre = texte.match(/POURQUOI INVESTIR DANS\s+([^?\n]+)\?/i);
        if (matchIntertitre) {
            const intertitreLower = matchIntertitre[1].toLowerCase();
            const contientCategorie = motsClesAttendus.some((mot) => intertitreLower.includes(mot));
            if (!contientCategorie) {
                hits.add(`intertitre du bloc 3 générique ("${matchIntertitre[0].trim()}") au lieu de nommer la catégorie réelle`);
            }
        }
    }

    return Array.from(hits);
}

// Addendum spécifique à gpt-5-nano (voir bascule ci-dessous) — gpt-5-nano suit le prompt de
// façon plus littérale que gpt-4o : sans ça, il recopiait les en-têtes internes "BLOC n" et
// l'instruction "omets la ligne X" telle quelle dans le texte publié (constaté sur plusieurs
// dizaines de lots réels avant correction, plus aucune occurrence après). Validé sur 3 vagues de
// test indépendantes (36 lots variés, 5 catégories, 7 villes) avant bascule en production.
const PROMPT_ADDENDUM_GPT5 = `

=== CONSIGNE DE FORMAT SUPPLÉMENTAIRE (spécifique à ce modèle) ===

Le champ "texte" que tu renvoies est publié TEL QUEL sur le site, lu directement par un client final — il ne doit jamais contenir la moindre trace de la structure interne de cette consigne.

Concrètement :
- N'écris JAMAIS les mots "BLOC", "BLOC 1", "BLOC 2", etc., ni aucun numéro de bloc. Les intertitres ci-dessus ("BLOC 1 — COMPRENDRE...") servent uniquement à t'organiser en interne : dans le texte final, seul l'intertitre proprement dit apparaît (ex. "COMPRENDRE IMMÉDIATEMENT LE LMNP GÉRÉ"), jamais précédé de "BLOC" ni d'un numéro.
- N'écris JAMAIS une instruction que tu es en train de suivre. Si une donnée est absente (ex: rentabilité non fournie), la ligne correspondante disparaît simplement du texte, sans aucune trace ni commentaire sur son absence ("omets la ligne", "non disponible avec certitude" ne doivent JAMAIS apparaître dans ta réponse — applique la règle, ne la décris pas).
- Rédige exclusivement en français courant, sans aucun mot ni tournure anglaise mélangée au texte français (ex: n'écris jamais "according to", "business", "fallback" ou tout autre terme anglais au milieu d'une phrase française — traduis intégralement).

Exemple de sortie CORRECTE pour la section chiffres clés quand la rentabilité n'est pas disponible (n'invente pas ces valeurs, c'est un exemple de FORME uniquement) :

LES CHIFFRES CLÉS

Prix : 172 000 €
Surface : 41,7 m²
Annexes : 5 m² de balcon, 1 parking extérieur

(remarque pour toi : aucune ligne "Rentabilité" n'apparaît ci-dessus — c'est le comportement attendu ; ne reproduis jamais cette remarque entre parenthèses dans ta réponse, elle est uniquement là pour t'expliquer l'exemple)`;

// Alternatives toutes prêtes par famille de mot interdit — la correction devient une substitution
// mécanique plutôt qu'une reformulation libre : gpt-5-nano, plus petit que gpt-4o, respecte moins
// bien une consigne de correction nuancée ("réécris en évitant ce mot") qu'une substitution
// directe et sans ambiguïté. Validé : a rattrapé 5/5 violations réelles observées en test.
function alternativesPourCorrection(hits, lot) {
    const lignes = [];
    if (hits.some((h) => h.startsWith('titre non conforme'))) {
        lignes.push(
            '- Corrige le titre pour respecter EXACTEMENT la structure "{Type de bien/résidence} – {formule investissement}" : une des deux formules "investissement LMNP géré" ou "LMNP 100 % géré" est obligatoire, jamais la ville.'
        );
    }
    if (hits.some((h) => h.startsWith('DPE/GES mentionné'))) {
        lignes.push(
            '- Supprime toute mention du DPE ou du GES dans le texte (lettre, "classe énergétique", "classe climat"...) — ces données ne doivent plus jamais apparaître dans l\'annonce, elles restent uniquement dans les champs structurés réglementaires. Supprime la ligne ou la mention entièrement, ne la remplace par rien.'
        );
    }
    if (hits.some((h) => h.startsWith('CTA LMNP'))) {
        lignes.push(
            `- Corrige le bloc final pour respecter EXACTEMENT cette structure en 3 parties : (1) une de ces phrases, choisis celle qui s'enchaîne le mieux :\n${LMNP_CTA_PHRASES_AUTORISEES.map((p) => `  « ${p} »`).join('\n')}\n  (2) immédiatement suivie des coordonnées exactes, reproduites telles quelles :\n  La Centrale du LMNP\n  ${LMNP_TELEPHONE}\n  https://www.lacentraledulmnp.fr/\n  (3) puis, en toute dernière position, exactement : « ${LMNP_PHRASE_FINALE} » — rien après.`
        );
    }
    if (hits.some((h) => h.includes('rentabilité/rendement chiffré'))) {
        lignes.push(
            '- Supprime entièrement toute mention d\'un pourcentage de rentabilité ou de rendement locatif — cette donnée n\'est jamais fiable pour ce type de bien dans ce pipeline, quelle que soit la valeur vue dans les données brutes. La phrase reste correcte sans elle.'
        );
    }
    if (hits.some((h) => h.includes('proximité (transports/commerces/écoles)'))) {
        lignes.push(
            '- Supprime toute mention de proximité des transports, commerces ou écoles dans le bloc ENVIRONNEMENT — cette information n\'est pas confirmée pour ce lot. Recentre le bloc sur ce qui est réellement connu (ville, éventuellement le nom de la résidence), ou supprime le bloc entier si rien d\'autre n\'est disponible.'
        );
    }
    if (hits.some((h) => h.includes('mot "neuf" interdit'))) {
        lignes.push(
            '- Pour "neuf"/"neufs" appliqué au bien/logement/programme/résidence → remplace par "récent"/"récents" (ou "récente"/"récentes" selon l\'accord) — jamais par une autre formulation qui reclasserait implicitement le bien dans le neuf (ex: "tout juste construit", "sortant de terre", "livraison imminente").'
        );
    }
    if (hits.some((h) => h.includes('garanti'))) {
        lignes.push(
            '- Pour "loyer garanti" / "revenus garantis" / "garantissant le versement du loyer" → remplace par exactement : "le loyer est versé selon les conditions du bail commercial".',
            '- Pour "garantissant" appliqué à autre chose (service, prestation, stationnement...) → supprime simplement le mot "garantissant" et la phrase reste correcte sans lui (ex: "un parking sécurisé" devient "un parking", "garantissant une prestation adaptée" devient "avec une prestation adaptée").'
        );
    }
    if (hits.some((h) => h.includes('sécuris') || h.includes('sécurité'))) {
        lignes.push(
            '- Pour "sécurisé"/"sécurisée"/"sécurité" → supprime le mot, ou remplace par "adapté", "de qualité" ou "confortable" selon le contexte — jamais par un synonyme de certitude.'
        );
    }
    if (hits.some((h) => h.includes("plus d'un superlatif dans le texte"))) {
        lignes.push(
            '- Le texte contient plus d\'un superlatif ("magnifique", "exceptionnel", "superbe"...). Garde au maximum UN SEUL superlatif dans tout le texte — celui qui est le plus objectivement justifié par une donnée réelle du dossier — et remplace chaque autre occurrence par une formulation neutre qui décrit simplement la caractéristique, sans adjectif emphatique.'
        );
    }
    if (hits.some((h) => h.includes('superlatif détecté dans le titre'))) {
        lignes.push(
            '- Retire tout superlatif du titre ("magnifique", "superbe", "exceptionnel", "rare", "coup de cœur"...) — le titre reste factuel et concret, sans adjectif emphatique, même si un superlatif est utilisé dans le texte.'
        );
    }
    if (hits.some((h) => h.includes('donnée manquante explicitée'))) {
        lignes.push(
            '- Pour "non communiqué"/"non fourni"/"non renseigné"/"non spécifié"/"non précisé"/"non disponible" appliqué à une donnée absente (loyer, rentabilité, annexe, balcon...) → supprime ENTIÈREMENT la ligne ou la mention concernée, ne la remplace par aucun texte, aucune formule d\'absence. L\'information disparaît simplement du texte comme si elle n\'avait jamais été envisagée.'
        );
    }
    if (hits.some((h) => h.includes('DPE : consommation chiffrée inventée'))) {
        lignes.push(
            '- Supprime toute mention d\'une consommation énergétique chiffrée (kWh/m²/an) — cette donnée n\'est jamais fournie et ne doit jamais apparaître, inventée ou non. Les lettres DPE et GES (si connues) peuvent rester, seule la valeur en kWh doit disparaître.'
        );
    }
    const gesHit = hits.find((h) => h.startsWith('lettre GES mentionnée'));
    if (gesHit) {
        const gesReelMatch = gesHit.match(/réel : (aucune donnée GES connue|[A-G])/);
        const gesReel = gesReelMatch ? gesReelMatch[1] : null;
        lignes.push(
            gesReel && gesReel !== 'aucune donnée GES connue'
                ? `- La lettre GES mentionnée dans le texte est fausse. La vraie lettre GES de ce lot est "${gesReel}" — remplace-la partout où le texte mentionne une lettre GES.`
                : '- Le texte mentionne une lettre GES alors qu\'aucune donnée GES n\'est connue pour ce lot — supprime entièrement cette mention (garde le DPE seul si sa lettre est connue).'
        );
    }
    if (hits.some((h) => h.includes('fuite de ton "documents/sources internes"'))) {
        lignes.push(
            '- Pour toute mention de "documents", "fiches", "plan", "sources" ou "disponible(s) pour référence" — supprime entièrement la phrase ou reformule en pur langage commercial destiné au lecteur, sans jamais évoquer l\'existence de documents/fiches/dossiers/sources internes au pipeline (ex: "avec plan et fiches partenaires disponibles pour référence" devient simplement rien, ou une caractéristique réelle du bien si le contexte en fournit une).'
        );
    }
    if (hits.some((h) => h.includes('sans annexe réelle de ce type'))) {
        const annexesReelles = lot?.annexesSurfaces || [];
        const typesReels = annexesReelles.map((a) => a.type.toLowerCase()).join(', ') || 'aucune';
        lignes.push(
            `- Le texte mentionne un type d'annexe extérieure (balcon/terrasse/loggia) qui ne correspond pas à la réalité de ce lot. Annexe(s) réelle(s) de ce lot : ${typesReels}. Remplace chaque mention incorrecte par le bon terme si une annexe réelle existe (ex: "terrasse" → "balcon" si c'est un balcon), ou supprime la mention entièrement si le lot n'a aucune annexe de ce type — ne mélange jamais les deux mots.`
        );
    }
    const promoteurHit = hits.find((h) => h.startsWith('nom du promoteur cité'));
    if (promoteurHit) {
        const nomPromoteur = lot?.program?.developer?.name;
        lignes.push(
            `- Le nom "${nomPromoteur}" est celui du PROMOTEUR (jamais l'exploitant), il est interdit de le citer. Remplace chaque occurrence par une formulation générique : "un exploitant professionnel", "un gestionnaire professionnel", ou "la résidence" selon le contexte — jamais de nom propre d'entreprise.`
        );
    }
    if (hits.some((h) => h.includes("état d'avancement de la résidence révélé"))) {
        lignes.push(
            '- Le texte laisse deviner si la résidence est déjà construite, en cours de construction ou à venir (ex: "future résidence", "en construction", "livraison prévue", "une fois achevée", "vient d\'être achevée"...). Reformule en une tournure neutre et intemporelle qui ne permet ni de confirmer ni d\'infirmer l\'état d\'avancement (ex: "Au sein d\'une résidence de standing...", "Cette adresse résidentielle bénéficie de prestations soignées..."). Ne remplace jamais par une autre formulation qui révélerait l\'information dans l\'autre sens.'
        );
    }
    if (hits.some((h) => h.includes('formulation "IA générique" interdite'))) {
        lignes.push(
            '- Supprime toute formulation générique de type IA détectée ("niché au cœur de", "havre de paix", "écrin de verdure", "opportunité à ne pas manquer", "bien d\'exception", "coup de cœur assuré", "véritable pépite", "vous serez immédiatement séduit") et remplace-la par une phrase factuelle décrivant une caractéristique réelle du bien ou de sa localisation, sans emphase artificielle.'
        );
    }
    if (hits.some((h) => h.includes('"Frais de notaire réduits" absente'))) {
        lignes.push(
            '- Ajoute la mention "Frais de notaire réduits" — elle doit apparaître systématiquement dans chaque annonce, idéalement dans la section finale des avantages, sans jamais donner de pourcentage précis. N\'invente aucune autre information en l\'ajoutant.'
        );
    }
    if (hits.some((h) => h.includes('"Aucun travaux à prévoir" absente'))) {
        lignes.push(
            '- Ajoute la mention "Aucun travaux à prévoir" — elle doit apparaître systématiquement dans chaque annonce, idéalement dans la section finale des avantages. Formule-la de façon neutre, sans jamais laisser entendre si la résidence est déjà construite ou non (ne pas écrire par exemple "vous pouvez emménager immédiatement" ou "les travaux viennent de se terminer").'
        );
    }
    if (hits.some((h) => h.startsWith('CTA final'))) {
        lignes.push(
            `- Le texte doit se terminer EXACTEMENT par l'une de ces phrases, mot pour mot, rien après (pas d'espace, de ligne ni de commentaire supplémentaire) :\n${CTA_PHRASES_AUTORISEES.map((p) => `  « ${p} »`).join('\n')}\n  Choisis celle qui s'enchaîne le mieux avec la phrase précédente, ne modifie jamais le numéro de téléphone, et supprime tout texte qui se trouverait après cette phrase.`
        );
    }
    if (hits.some((h) => h.startsWith('texte trop court'))) {
        lignes.push(
            '- Le texte est trop court alors que le descriptif du programme fourni dans les données contient davantage d\'éléments exploitables. Relis intégralement ce descriptif (pas seulement ses premières lignes) et développe surtout les paragraphes ENVIRONNEMENT/LOCALISATION et RÉSIDENCE/PRESTATIONS en reprenant au moins 3 éléments factuels distincts dans chacun (quartier, chiffres de marché local, prestations, équipements...), toujours sans inventer une information absente. Vise 350 à 550 mots au total.'
        );
    }
    if (hits.some((h) => h.includes('intertitre du bloc 3 générique'))) {
        const libelle = lot?.program?.residenceType ? LIBELLES_CATEGORIE_RESIDENCE[lot.program.residenceType] : null;
        lignes.push(
            libelle
                ? `- L'intertitre du bloc 3 doit nommer explicitement la catégorie : remplace-le par exactement "POURQUOI INVESTIR DANS ${libelle.replace(/^une?\s+/i, '').toUpperCase()} ?" (ou une variante grammaticale naturelle qui contient bien ce nom de catégorie), jamais une formule vague comme "CETTE CATÉGORIE" ou "CE TYPE DE RÉSIDENCE".`
                : '- L\'intertitre du bloc 3 doit nommer explicitement le type de résidence identifié, jamais une formule vague comme "CETTE CATÉGORIE".'
        );
    }
    lignes.push('- Règle générale si aucune alternative ci-dessus ne correspond exactement : supprime simplement le mot fautif et ajuste la phrase pour qu\'elle reste grammaticalement correcte sans lui — la suppression pure est toujours une réponse acceptée, ne cherche pas de synonyme subtil.');
    return lignes.join('\n');
}

// Construit le bloc "PHOTOS DISPONIBLES" (liste des noms, dans l'ordre où les images suivent
// juste après dans le message) + les blocs image eux-mêmes — partagé entre callOpenAILmnp et
// callOpenAINeuf. Sans cette liste de noms en préambule, le modèle voit une suite de photos sans
// pouvoir les désigner par leur nom réel (les blocs image n'ont pas de nom attaché) — il ne
// pourrait renvoyer qu'un numéro d'ordre, plus fragile à valider après coup qu'un nom exact.
function construireBlocPhotos(lotImageData) {
    if (!lotImageData?.length) return { texte: '', blocsImage: [] };
    const texte =
        '\n\nPHOTOS DISPONIBLES (dans cet ordre, pour référence — reprends le nom EXACT pour "photoPrincipale") :\n' +
        lotImageData.map((img, i) => `${i + 1}. ${img.name}`).join('\n');
    const blocsImage = lotImageData.map((img) => ({ type: 'image_url', image_url: { url: img.data } }));
    return { texte, blocsImage };
}

// Vérifie que le nom renvoyé par le modèle correspond bien à une vraie photo de ce lot — jamais
// un nom inventé ou approximatif transmis tel quel (même principe que les autres contrôles
// "donnée réelle" de ce pipeline : DPE/GES, annexes, promoteur). Comparaison insensible à la
// casse (le modèle recopie parfois avec une casse légèrement différente), mais jamais une
// correspondance partielle/floue — en cas de doute, repli sur null plutôt que de deviner.
function validerPhotoPrincipale(nomPropose, lotImageData) {
    if (!nomPropose || typeof nomPropose !== 'string') return null;
    const trouve = (lotImageData || []).find((img) => (img.name || '').toLowerCase() === nomPropose.toLowerCase());
    return trouve ? trouve.name : null;
}

// Titre LMNP (règles précises du client, 2026-09-23) : structure obligatoire "{Type de bien/
// résidence} – {formule investissement}", une des deux formules ("investissement LMNP géré" /
// "LMNP 100 % géré") obligatoire, ville jamais mentionnée. Constaté en test réel (5 lots, 4
// catégories) : la seule instruction du prompt échoue occasionnellement sur la présence de la
// formule — même limite déjà documentée ailleurs dans ce pipeline pour d'autres règles de titre.
// Pas de contrainte de longueur ici : le client n'en a demandé aucune, et sa longueur découle
// simplement du type de bien/résidence choisi (ex: "Chambre EHPAD" vs "Appartement en résidence
// services seniors") — une fourchette de caractères basée sur les 6 exemples fournis rejetterait à
// tort des titres structurellement corrects mais avec un type de bien plus court ou plus long que
// ces exemples précis (constaté : "Studio étudiant – LMNP 100 % géré – idéal investisseur", 54
// caractères, est un titre parfaitement conforme mais tomberait hors d'une fourchette calquée sur
// les 57-66 caractères des 6 exemples du client).
const FORMULE_INVESTISSEMENT_LMNP_RE = /investissement LMNP g[ée]r[ée]|LMNP 100\s*%\s*g[ée]r[ée]/i;

function detecterProblemeTitreLmnp(titre, lot) {
    if (!titre) return 'titre absent';
    const problemes = [];
    if (!FORMULE_INVESTISSEMENT_LMNP_RE.test(titre)) {
        problemes.push('formule d\'investissement obligatoire absente du titre ("investissement LMNP géré" ou "LMNP 100 % géré")');
    }
    const ville = lot?.program?.address?.city?.name;
    if (ville && titre.toLowerCase().includes(ville.toLowerCase())) {
        problemes.push('ville mentionnée dans le titre (interdit)');
    }
    return problemes.length > 0 ? problemes.join(' ; ') : null;
}

// DPE/GES retirés du texte LMNP (règle client, 2026-09-23) : ces données restent uniquement dans
// les champs structurés réglementaires, plus jamais dans le corps de l'annonce. Le textContext
// (dump JSON complet du lot) contient toujours "DPE"/"GES" en texte libre dans la description
// brute — l'instruction seule ne suffit pas forcément à empêcher le modèle de la reprendre, d'où
// ce filet de sécurité, même principe que les autres garde-fous de ce pipeline.
const DPE_GES_MENTION_RE = /\bDPE\b|\bGES\b|classe\s+[ée]nerg[ée]tique|classe\s+climat/i;

// CTA final LMNP (règle client, 2026-09-23) : une des 3 phrases d'accroche obligatoires, suivie
// des coordonnées exactes, puis la phrase finale fixe sur le chat 7j/7 — même approche que le CTA
// Neuf (voir detecterProblemeCta), adaptée à une structure en 3 parties plutôt qu'une phrase unique.
const LMNP_CTA_PHRASES_AUTORISEES = [
    "Contactez-nous pour en savoir plus sur cette opportunité d'investissement.",
    'Contactez La Centrale du LMNP pour en savoir plus.',
    'Obtenez plus d\'informations sur cet investissement LMNP en nous contactant.',
];
const LMNP_PHRASE_FINALE = 'Comparez les biens LMNP avec le chat 7j/7 de La Centrale du LMNP.';
const LMNP_TELEPHONE = '02 79 02 11 11';
const LMNP_URL_RE = /lacentraledulmnp\.fr/i;

function detecterProblemeCtaLmnp(texte) {
    if (!texte) return 'CTA LMNP manquant (aucun texte)';
    if (!LMNP_CTA_PHRASES_AUTORISEES.some((p) => texte.includes(p))) {
        return 'CTA LMNP : aucune des 3 phrases d\'accroche obligatoires détectée';
    }
    if (!texte.includes(LMNP_TELEPHONE)) {
        return `CTA LMNP incomplet : numéro de téléphone "${LMNP_TELEPHONE}" absent`;
    }
    if (!LMNP_URL_RE.test(texte)) {
        return 'CTA LMNP incomplet : URL "lacentraledulmnp.fr" absente';
    }
    if (!texte.trim().endsWith(LMNP_PHRASE_FINALE)) {
        return 'CTA LMNP : phrase finale "Comparez les biens LMNP avec le chat 7j/7..." absente ou pas en toute dernière position';
    }
    return null;
}

async function callOpenAILmnp(textContext, lotImageData, lot) {
    const donneesFiables = donneesFinancieresFiablesDepuisLot(lot);
    const residenceType = lot.program?.residenceType || null;
    const libelleCategorie = residenceType ? LIBELLES_CATEGORIE_RESIDENCE[residenceType] || null : null;

    let blocDonneesConnues = 'DONNÉES CONNUES AVEC CERTITUDE :\n';
    if (libelleCategorie) {
        blocDonneesConnues += `- Catégorie de résidence (Otaree) : ${libelleCategorie} — utilise EXACTEMENT ce libellé français (ou une variante grammaticale naturelle), ne recopie jamais la valeur anglaise brute "${residenceType}".\n`;
    } else if (residenceType) {
        blocDonneesConnues += `- Catégorie de résidence (Otaree, valeur brute non reconnue "${residenceType}") : déduis-la du contexte disponible sans jamais confondre senior et EHPAD.\n`;
    } else {
        blocDonneesConnues += '- Catégorie de résidence : non fournie, déduis-la du contexte disponible sans jamais confondre senior et EHPAD.\n';
    }
    if (donneesFiables?.prix != null) blocDonneesConnues += `- Prix : ${donneesFiables.prix} €\n`;
    if (donneesFiables?.loyerMensuel != null) blocDonneesConnues += `- Loyer mensuel : ${donneesFiables.loyerMensuel} € (loyer annuel = x12)\n`;
    if (donneesFiables?.rentabilite != null) {
        blocDonneesConnues += `- Rentabilité : ${donneesFiables.rentabilite}% (déjà calculée par la source — utilise cette valeur telle quelle, ne recalcule jamais)\n`;
    } else {
        blocDonneesConnues += `- Rentabilité : non disponible avec certitude — omets la ligne "Rentabilité" dans les chiffres clés.\n`;
    }

    const { texte: blocPhotos, blocsImage } = construireBlocPhotos(lotImageData);
    const messageContent = [
        { type: 'text', text: blocDonneesConnues + '\n\nDonnées structurées complètes du lot :\n\n' + (textContext || '(Aucun texte, base-toi sur les images)') + blocPhotos },
        ...blocsImage,
    ];

    const messages = [{ role: 'system', content: PROMPT_SYSTEME_LMNP_V2 + PROMPT_ADDENDUM_GPT5 }, { role: 'user', content: messageContent }];

    let resultat, hits = [];
    const MAX_TENTATIVES_CONFORMITE = 3;
    for (let essai = 1; essai <= MAX_TENTATIVES_CONFORMITE; essai++) {
        let response;
        for (let tentative = 1; tentative <= 3; tentative++) {
            try {
                // Repassé sur gpt-4o (2026-09-11, demande client : trop de fautes d'orthographe
                // et qualité de rédaction insuffisante avec gpt-5-nano) — seul le modèle change,
                // le prompt (PROMPT_SYSTEME_LMNP_V2 + PROMPT_ADDENDUM_GPT5) reste identique. Les
                // paramètres reasoning_effort/max_completion_tokens (spécifiques aux modèles de
                // raisonnement gpt-5) n'existent pas pour gpt-4o — remplacés par
                // temperature/max_tokens, mêmes valeurs que celles déjà éprouvées sur le chemin
                // générique (callOpenAI, resté sur gpt-4o depuis toujours).
                response = await axios.post('https://api.openai.com/v1/chat/completions', {
                    model: 'gpt-4o',
                    messages,
                    temperature: 0.7,
                    max_tokens: 4000,
                    // Mode JSON strict d'OpenAI — sans ça, un texte long avec guillemets/apostrophes
                    // (ex: nom de résidence entre guillemets dans la description) peut produire un
                    // JSON mal formé et faire échouer JSON.parse malgré le prompt qui le demande déjà
                    // en texte. Constaté en conditions réelles (lot Le Havre) : erreur de parsing
                    // JSON alors que les 2 autres lots testés en même temps ont fonctionné.
                    response_format: { type: 'json_object' },
                }, {
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                    // Sans timeout, un appel qui traîne (ou une connexion qui stalle) pouvait
                    // bloquer silencieusement plusieurs minutes sans jamais déclencher la boucle
                    // de retry 429 ci-dessous, qui ne réagit qu'aux erreurs HTTP explicites.
                    timeout: 60000,
                });
                break;
            } catch (e) {
                if (e.response?.status !== 429 || tentative === 3) throw e;
                const delaiMs = 1000 * 2 ** (tentative - 1);
                console.log(`[callOpenAILmnp] 429 (limite de débit) — nouvelle tentative dans ${delaiMs}ms (${tentative}/3)`);
                await new Promise((r) => setTimeout(r, delaiMs));
            }
        }

        await enregistrerUsageOpenAI(response.data.usage, 'gpt-4o');

        let content = response.data.choices[0].message.content;
        content = (content || '').replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
        try {
            resultat = JSON.parse(content);
        } catch (e) {
            throw new Error(`JSON.parse a échoué (finish_reason=${response.data.choices[0].finish_reason}, contenu brut="${content.substring(0, 200)}")`);
        }
        hits = detecterProblemesConformite(resultat.texte, lot);
        const problemeTitre = detecterProblemeTitreLmnp(resultat.titre, lot);
        if (problemeTitre) {
            hits = [...hits, `titre non conforme : ${problemeTitre}`];
        }
        if (DPE_GES_MENTION_RE.test(resultat.texte || '')) {
            hits = [...hits, 'DPE/GES mentionné dans le texte (interdit, uniquement dans les champs structurés désormais)'];
        }
        const problemeCta = detecterProblemeCtaLmnp(resultat.texte);
        if (problemeCta) {
            hits = [...hits, problemeCta];
        }
        if (hits.length === 0) break;

        if (essai < MAX_TENTATIVES_CONFORMITE) {
            console.log(`[callOpenAILmnp] formulation(s) interdite(s) détectée(s) (${hits.join(', ')}) — nouvelle tentative avec correction ciblée`);
            messages.push({ role: 'assistant', content: JSON.stringify(resultat) });
            messages.push({
                role: 'user',
                content: `Ta réponse précédente contient un problème détecté par notre vérification automatique : ${hits.join(', ')}.\n\nCorrige en appliquant EXACTEMENT l'une de ces substitutions (ne réinvente pas une reformulation différente) :\n${alternativesPourCorrection(hits, lot)}\n\nNe change rien d'autre au fond ni à la structure. Réponds à nouveau uniquement avec le JSON {"titre": "...", "texte": "...", "photoPrincipale": "..."} (garde la même valeur de photoPrincipale qu'avant, elle n'est pas concernée par cette correction).`,
            });
        }
    }

    // alerteConformite non-null : la formulation interdite est toujours là après la seconde
    // tentative — le texte est quand même renvoyé (mieux vaut une annonce à corriger à la main
    // qu'aucune), mais orchestrator.js bloque la publication automatique de ce lot précis tant
    // qu'un humain n'a pas vérifié (voir executerTraitement).
    return {
        titre: resultat.titre,
        texte: resultat.texte,
        photoPrincipale: validerPhotoPrincipale(resultat.photoPrincipale, lotImageData),
        alerteConformite: hits.length > 0 ? hits : null,
    };
}

// Prompt V1 Neuf (client, 2026-09-12, voir PROMPT_SYSTEME_NEUF_V1) — branché sur le chemin
// ag762216 ("Plusimmo - La Centrale du Neuf"), remplace l'ancien chemin générique callOpenAI
// pour ce portail. Même structure que callOpenAILmnp (retry 429, mode JSON strict, garde-fou de
// conformité partagé) : les champs structurés (surface, étage, exposition, balcon/terrasse/
// loggia, garage/box/cave, parking, DPE, adresse...) ne sont volontairement PAS demandés à l'IA
// ici — ils viennent tous de champsConnusDepuisLot(lot), écrasés après coup dans /api/generate,
// exactement comme pour le LMNP. Cette fonction ne renvoie que titre+texte, jamais de champ
// structuré deviné.
// Deux garde-fous spécifiques au chemin Neuf, ajoutés après test réel sur 4 lots (2026-09-12) —
// le prompt V1 interdit déjà ces deux dérives par instruction, mais l'instruction seule n'a pas
// suffi (même constat que partout ailleurs dans ce pipeline) :
//
// 1. Rentabilité/rendement chiffré : Otaree fournit un champ "profitability" sur prices[], mais
//    sa fiabilité n'est validée QUE pour le LMNP marché secondaire à TVA nulle (voir
//    donneesFinancieresFiablesDepuisLot) — jamais pour le Neuf/Pinel, où la TVA est presque
//    toujours renseignée. Sans garde-fou, le modèle cite ce chiffre tel quel dès qu'il le voit
//    dans les données brutes (constaté : "Profitez d'une rentabilité de 6.44%." sur un lot réel).
//    Pas de mécanisme "DONNÉES CONNUES AVEC CERTITUDE" ici comme pour le LMNP : plus simple
//    d'interdire totalement la citation d'un chiffre de rentabilité que de le fiabiliser.
// 2. Proximité (transports/commerces/écoles) non sourcée : Otaree ne fournit JAMAIS de distance
//    ou de POI vérifié dans ce pipeline — confirmé par échantillonnage réel, aucun des 4 lots
//    testés n'avait la moindre mention de proximité dans son descriptif source, alors que le
//    modèle en a inventé une à chaque fois ("à proximité immédiate des transports et des
//    commodités", "proche des commerces, écoles et transports"...). Cross-vérifie contre le texte
//    source réel du lot (description/program.description) plutôt que d'interdire le mot lui-même
//    — une mention légitime (si un jour Otaree fournit cette donnée) resterait acceptée.
const RENTABILITE_CHIFFREE_RE = /(rentabilit[ée]|rendement)[^.\n]{0,25}\d/i;
// NB frontière `(?<![a-zà-ÿ])`/`(?![a-zà-ÿ])` plutôt que `\b` pour "écoles"/"proximité" — même
// bug déjà documenté ailleurs dans ce pipeline (voir FORMULATIONS_INTERDITES, "sécuris*/sécurité")
// : `\b` se base sur `\w`, purement ASCII, donc ne détecte aucune frontière avant/après une
// lettre accentuée. Vérifié : `\bécoles?\b`/`\bproximit[ée]\b` ne matchaient JAMAIS "à proximité"
// ni "proche des écoles" — silencieusement, sans erreur — avant cette correction.
const MOTS_PROXIMITE_RE = /\btransports?\b|\bcommerces?\b|(?<![a-zà-ÿ])écoles?(?![a-zà-ÿ])|(?<![a-zà-ÿ])proximit[ée](?![a-zà-ÿ])|\bproche des?\b|\bdesservi\w*|\bdessert\b|\bligne de (bus|tram|m[ée]tro)\b/i;

function detecterProximiteNonSourcee(texte, lot) {
    if (!texte || !MOTS_PROXIMITE_RE.test(texte)) return false;
    const sourceTexte = [lot?.description, lot?.program?.description].filter(Boolean).join(' ');
    return !MOTS_PROXIMITE_RE.test(sourceTexte);
}

// Assouplissement du 2026-09-18 (prompt V1 Neuf uniquement, décision confirmée côté client) : un
// superlatif positif est désormais toléré, mais l'instruction seule dans le prompt ne suffit pas
// à la respecter de façon fiable (constaté en test réel le jour même : 2 superlatifs dans le
// texte + 1 dans le titre sur 1 lot testé sur 4, alors que le prompt limite à 1 maximum dans le
// texte et 0 dans le titre) — même limite que les autres garde-fous de ce pipeline (le prompt
// seul échoue parfois à ~0,7 de température). Liste volontairement limitée aux superlatifs les
// plus caractéristiques, pas une détection de ton exhaustive.
const SUPERLATIFS_RE = /\b(magnifiques?|exceptionnels?|incroyables?|superbes?|extraordinaires?|somptueux|somptueuses?|sublimes?|idylliques?)\b/gi;

function compterSuperlatifs(texte) {
    if (!texte) return 0;
    return (texte.match(SUPERLATIFS_RE) || []).length;
}

// Titre Neuf (2026-09-22, règles précises du client) : liste EXACTE des superlatifs interdits
// dans le titre — plus large que SUPERLATIFS_RE ci-dessus (qui régit la tolérance "1 max dans le
// texte", un sujet différent) : "coup de cœur" et "rare" n'ont pas leur place dans SUPERLATIFS_RE
// (légitimes dans le corps du texte selon le contexte), mais sont explicitement bannis du titre
// par cette nouvelle règle. Jamais appliqué au texte, seulement au titre.
// Jamais le flag "g" ici : .test() sur un regex global garde son lastIndex entre deux appels,
// ce qui alternerait faussement vrai/faux sur des titres successifs partageant ce même objet
// regex (piège JS classique — sans rapport avec SUPERLATIFS_RE ci-dessus, qui utilise .match()
// et a donc besoin de "g").
const SUPERLATIFS_TITRE_RE = /\b(magnifiques?|exceptionnels?|superbes?|rares?)\b|coup de c[oœ]+ur/i;

function contientSuperlatifTitre(titre) {
    if (!titre) return false;
    return SUPERLATIFS_TITRE_RE.test(titre);
}

// Prompt V2 Neuf (2026-09-23, document client "NIRA - DESCRIPTION NEUF") : contrairement à la V1
// qui autorisait de laisser deviner l'état d'avancement (via "récent"), la V2 l'interdit dans les
// deux sens. Liste reprise du document client, chaque formulation testée sans "\b" en tête/fin là
// où l'expression commence/finit par un participe accentué (même piège documenté ailleurs dans ce
// fichier pour "sécurisé"/"proximité" — "\b" ne détecte aucune frontière autour d'une lettre
// accentuée). Neuf uniquement, jamais partagé avec le chemin LMNP.
const ETAT_AVANCEMENT_INTERDIT_RE = /future résidence|résidence en construction|en cours de construction|actuellement en travaux|prochainement disponible|livraison prévue|programme à venir|verra prochainement le jour|une fois achevée|à sa livraison|emménager immédiatement|(le logement|l'appartement|la maison) est déjà terminé|vient d'être achevée|viennent de se terminer|résidence (vient|est) (déjà )?livrée/i;

// Formulations "IA générique" bannies par le document client ("sauf justification réelle" pour
// "écrin de verdure" dans le prompt lui-même — mais bannies ici sans exception au niveau code,
// même principe que "sécurisé" plus haut : le garde-fou code est volontairement plus strict que
// la nuance du prompt, en filet de sécurité).
const FORMULATIONS_IA_GENERIQUES_RE = /nich[ée]e?\s+au\s+c[oœ]ur\s+de|havre de paix|écrin de verdure|opportunité à ne pas manquer|bien d'exception|coup de c[oœ]ur assuré|véritable pépite|serez immédiatement séduit/i;

const FRAIS_NOTAIRE_REDUITS_RE = /frais de notaire réduits?/i;
const AUCUN_TRAVAUX_A_PREVOIR_RE = /aucune?\s+travaux?\s*(à|a)\s*pr[ée]voir/i;

// CTA final obligatoire (document client, section 17) : liste EXACTE des 7 phrases autorisées,
// numéro de téléphone inclus — jamais une paraphrase, jamais rien après. Comparaison sur le texte
// TRIMMÉ (espaces/retours à la ligne finaux ignorés), la phrase doit se trouver littéralement à la
// toute fin.
const CTA_PHRASES_AUTORISEES = [
    "Pour en découvrir plus sur ce bien, contactez Plusimmo au 02 32 86 47 72.",
    "Pour plus d'informations sur ce bien, contactez Plusimmo au 02 32 86 47 72.",
    "Pour découvrir ce bien plus en détail, contactez Plusimmo au 02 32 86 47 72.",
    "Vous souhaitez en savoir plus sur ce bien ? Contactez Plusimmo au 02 32 86 47 72.",
    "Pour échanger sur ce bien et votre projet immobilier, contactez Plusimmo au 02 32 86 47 72.",
    "Pour connaître tous les détails de ce bien, contactez Plusimmo au 02 32 86 47 72.",
    "Pour obtenir plus de renseignements sur ce bien, contactez notre équipe Plusimmo au 02 32 86 47 72.",
];

// Retourne null si le CTA est conforme (une des 7 phrases, exactement à la fin), sinon un libellé
// de hit décrivant le problème précis (absent / téléphone incorrect / mal positionné).
function detecterProblemeCta(texte) {
    if (!texte) return 'CTA final manquant (aucun texte)';
    const t = texte.trim();
    if (t.endsWith('.')) {
        const finExacte = CTA_PHRASES_AUTORISEES.some((phrase) => t.endsWith(phrase));
        if (finExacte) return null;
    }
    if (!t.includes('02 32 86 47 72')) return 'CTA final manquant (numéro de téléphone absent)';
    return 'CTA final non conforme (doit être exactement une des 7 phrases autorisées, en toute dernière position, rien après)';
}

const ADDENDUM_NEUF_GARDE_FOUS = `

=== GARDE-FOUS SUPPLÉMENTAIRES (spécifiques à ce pipeline) ===

RENTABILITÉ : même si un pourcentage de rentabilité ou de rendement locatif apparaît dans les données brutes fournies, ne le mentionne JAMAIS dans le texte final — ce chiffre n'est pas fiabilisé pour ce type de bien (TVA variable) et pourrait induire en erreur. Omets-le systématiquement, quelle que soit sa plausibilité.

PROXIMITÉ (transports, commerces, écoles) : ce pipeline ne fournit JAMAIS de distance ou de point d'intérêt vérifié. Ne mentionne la proximité des transports, commerces ou écoles QUE si cette information apparaît explicitement dans le descriptif fourni pour CE bien — jamais comme supposition générale liée à la ville ou au quartier. En l'absence de cette donnée (le cas le plus fréquent), omets entièrement le sujet dans le bloc ENVIRONNEMENT plutôt que d'affirmer une proximité non vérifiée.`;

async function callOpenAINeuf(textContext, lotImageData, lot) {
    const { texte: blocPhotos, blocsImage } = construireBlocPhotos(lotImageData);
    const messageContent = [
        { type: 'text', text: 'Données structurées complètes du lot :\n\n' + (textContext || '(Aucun texte, base-toi sur les images)') + blocPhotos },
        ...blocsImage,
    ];

    const messages = [{ role: 'system', content: PROMPT_SYSTEME_NEUF_V1 + ADDENDUM_NEUF_GARDE_FOUS }, { role: 'user', content: messageContent }];

    let resultat, hits = [];
    const MAX_TENTATIVES_CONFORMITE = 3;
    for (let essai = 1; essai <= MAX_TENTATIVES_CONFORMITE; essai++) {
        let response;
        for (let tentative = 1; tentative <= 3; tentative++) {
            try {
                response = await axios.post('https://api.openai.com/v1/chat/completions', {
                    model: 'gpt-4o',
                    messages,
                    temperature: 0.7,
                    max_tokens: 4000,
                    response_format: { type: 'json_object' },
                }, {
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                    timeout: 60000,
                });
                break;
            } catch (e) {
                if (e.response?.status !== 429 || tentative === 3) throw e;
                const delaiMs = 1000 * 2 ** (tentative - 1);
                console.log(`[callOpenAINeuf] 429 (limite de débit) — nouvelle tentative dans ${delaiMs}ms (${tentative}/3)`);
                await new Promise((r) => setTimeout(r, delaiMs));
            }
        }

        await enregistrerUsageOpenAI(response.data.usage, 'gpt-4o');

        let content = response.data.choices[0].message.content;
        content = (content || '').replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
        try {
            resultat = JSON.parse(content);
        } catch (e) {
            throw new Error(`JSON.parse a échoué (finish_reason=${response.data.choices[0].finish_reason}, contenu brut="${content.substring(0, 200)}")`);
        }
        hits = detecterProblemesConformite(resultat.texte, lot);
        if (RENTABILITE_CHIFFREE_RE.test(resultat.texte || '')) {
            hits = [...hits, 'rentabilité/rendement chiffré non fiable pour ce chemin (Neuf)'];
        }
        if (detecterProximiteNonSourcee(resultat.texte, lot)) {
            hits = [...hits, 'proximité (transports/commerces/écoles) mentionnée sans être sourcée dans les données du lot'];
        }
        const nbSuperlatifsTexte = compterSuperlatifs(resultat.texte);
        if (nbSuperlatifsTexte > 1) {
            hits = [...hits, `plus d'un superlatif dans le texte (${nbSuperlatifsTexte} détectés, maximum 1 autorisé)`];
        }
        if (contientSuperlatifTitre(resultat.titre)) {
            hits = [...hits, 'superlatif détecté dans le titre (interdit, le titre reste factuel)'];
        }
        if (ETAT_AVANCEMENT_INTERDIT_RE.test(resultat.texte || '')) {
            hits = [...hits, "état d'avancement de la résidence révélé (interdit dans les deux sens, voir prompt section 4)"];
        }
        if (FORMULATIONS_IA_GENERIQUES_RE.test(resultat.texte || '')) {
            hits = [...hits, 'formulation "IA générique" interdite détectée (ex: "niché au cœur de", "havre de paix"...)'];
        }
        if (!FRAIS_NOTAIRE_REDUITS_RE.test(resultat.texte || '')) {
            hits = [...hits, 'mention "Frais de notaire réduits" absente (obligatoire dans chaque annonce)'];
        }
        if (!AUCUN_TRAVAUX_A_PREVOIR_RE.test(resultat.texte || '')) {
            hits = [...hits, 'mention "Aucun travaux à prévoir" absente (obligatoire dans chaque annonce)'];
        }
        const problemeCta = detecterProblemeCta(resultat.texte);
        if (problemeCta) {
            hits = [...hits, problemeCta];
        }
        // Constaté en tests réels (2026-09-23, plusieurs lots Neuf variés) : la seule instruction de
        // longueur du prompt (section 19) ne suffit pas à elle seule — même limite déjà documentée
        // ailleurs dans ce pipeline pour d'autres règles (superlatifs, etc.), "l'instruction seule
        // échoue parfois". Ici, le modèle produit un texte nettement sous la cible (350-550 mots)
        // même quand le descriptif du programme fourni est réellement riche (repéré : deux lots
        // testés avec un descriptif riche ne produisaient que ~185-215 mots). Le seuil de richesse
        // sert de proxy pour distinguer "peu de données disponibles" (cas légitime pour un texte
        // court, section 19) de "données disponibles mais sous-exploitées" (le seul cas visé par
        // ce garde-fou).
        // Seuil calibré empiriquement (2026-09-23) : 280 mots exigeait parfois un 4e essai que le
        // budget de retry actuel (MAX_TENTATIVES_CONFORMITE = 3, partagé avec tous les autres
        // garde-fous) ne permet pas d'atteindre de façon fiable — constaté sur plusieurs lots
        // réels, le texte plafonne souvent entre 230 et 260 mots au 3e essai. 230 reste un gain net
        // par rapport à la référence sans ce garde-fou (~185 mots), sans provoquer de retry inutile
        // au-delà du budget existant.
        // CORRECTIF (2026-09-23, incident réel Sedelka/Rouen — 10/11 lots bloqués) : le proxy de
        // richesse mesurait initialement `textContext.length` (le dump JSON complet du lot), pas
        // la vraie prose disponible — un lot SANS AUCUNE description (0 caractère de descriptif
        // programme) dépassait quand même 8000 caractères à cause du bruit structurel (URLs
        // d'images, structure de prix, adresse imbriquée...), déclenchant à tort une exigence de
        // longueur sur des lots réellement pauvres en contenu. Remplacé par la longueur réelle du
        // descriptif (lot + programme), le seul texte que le modèle peut effectivement exploiter.
        const nbMotsTexte = (resultat.texte || '').trim().split(/\s+/).filter(Boolean).length;
        const longueurDescriptifReel = ((lot?.description || '') + (lot?.program?.description || '')).length;
        if (nbMotsTexte < 230 && longueurDescriptifReel > 800) {
            hits = [...hits, `texte trop court (${nbMotsTexte} mots) alors que des données riches sont disponibles`];
        }
        if (hits.length === 0) break;

        if (essai < MAX_TENTATIVES_CONFORMITE) {
            console.log(`[callOpenAINeuf] formulation(s) interdite(s) détectée(s) (${hits.join(', ')}) — nouvelle tentative avec correction ciblée`);
            messages.push({ role: 'assistant', content: JSON.stringify(resultat) });
            messages.push({
                role: 'user',
                content: `Ta réponse précédente contient un problème détecté par notre vérification automatique : ${hits.join(', ')}.\n\nCorrige en appliquant EXACTEMENT l'une de ces substitutions (ne réinvente pas une reformulation différente) :\n${alternativesPourCorrection(hits, lot)}\n\nNe change rien d'autre au fond ni à la structure. Réponds à nouveau uniquement avec le JSON {"titre": "...", "texte": "...", "photoPrincipale": "..."} (garde la même valeur de photoPrincipale qu'avant, elle n'est pas concernée par cette correction).`,
            });
        }
    }

    return {
        titre: resultat.titre,
        texte: resultat.texte,
        photoPrincipale: validerPhotoPrincipale(resultat.photoPrincipale, lotImageData),
        alerteConformite: hits.length > 0 ? hits : null,
    };
}

// Garde-fou "document ne correspond pas au lot" (ex: plan d'un autre appartement) — PUREMENT
// INFORMATIF, contrairement aux garde-fous ci-dessus : ne bloque jamais la publication, ne
// modifie jamais rien silencieusement. Signale juste un doute pour vérification humaine (voir
// orchestrator.js, alerte_document). Un lot a souvent plusieurs documents nommés "plan" (plan de
// vente, plan de masse, plan sous-sol...) — un seul est le vrai plan du logement, d'où la
// vérification de tous ceux dont le nom contient "plan", pas un seul (constaté en explorant des
// lots réels). Coût mesuré en conditions réelles : ~$0,00007/document, gpt-5-nano.
const SEUIL_ECART_SURFACE_M2 = 3;
const SEUIL_ECART_SURFACE_PCT = 0.20;

async function extrairePlanImage(imageUrl) {
    const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const b64 = Buffer.from(imgResp.data).toString('base64');
    const dataUri = `data:image/jpeg;base64,${b64}`;

    const prompt = `Voici un document associé à un lot immobilier (peut-être un plan, peut-être autre chose). Extrais UNIQUEMENT ce qui est explicitement écrit/visible sur ce document, sans jamais deviner : la surface totale du logement en m² si indiquée, la typologie (ex: T1, T2, Studio) si indiquée. Réponds en JSON strict : {"surface": nombre ou null, "typologie": "..." ou null, "estPlanLogement": true/false}. "estPlanLogement":true UNIQUEMENT si ce document est bien le plan d'un logement individuel (pas un plan de masse, pas un plan de sous-sol/parking, pas une fiche gestionnaire).`;

    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-5-nano',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUri } }] }],
        response_format: { type: 'json_object' },
        reasoning_effort: 'minimal',
        max_completion_tokens: 1000,
    }, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    });

    await enregistrerUsageOpenAI(response.data.usage, 'gpt-5-nano');
    return JSON.parse(response.data.choices[0].message.content);
}

async function verifierDocumentsPlan(lot) {
    // Otaree concatène souvent les mêmes documents deux fois (images du lot + du programme,
    // voir enrichirLot) — dédupliqué par nom pour ne pas vérifier deux fois le même fichier
    // (constaté en conditions réelles : un lot avec 1 seul vrai plan pouvait en lister 2-3
    // occurrences identiques avant déduplication).
    const vus = new Set();
    const documentsPlan = (lot.documents || [])
        .map((doc) => ({ name: doc.file?.name || doc.name || '', url: doc.file?.urls?.large || doc.file?.urls?.medium || doc.urls?.large || doc.urls?.medium }))
        .filter((doc) => {
            if (!doc.url || !/plan/i.test(doc.name)) return false;
            const cle = doc.name.toLowerCase();
            if (vus.has(cle)) return false;
            vus.add(cle);
            return true;
        })
        .slice(0, 4); // borne le coût/latence même si un lot a beaucoup de documents "plan" distincts

    if (documentsPlan.length === 0) return null;

    // En parallèle entre eux (pas seulement avec la génération IA du lot) : un lot avec
    // plusieurs documents "plan" distincts ne doit pas accumuler leur latence en série.
    const resultats = await Promise.allSettled(
        documentsPlan.map(async (doc) => ({ doc, extrait: await extrairePlanImage(doc.url) }))
    );

    for (const resultat of resultats) {
        if (resultat.status === 'rejected') {
            // Un document illisible/inaccessible ne doit jamais faire échouer la génération —
            // juste ignoré, comme une absence d'info (voir principe "ne jamais deviner").
            console.error('[verifierDocumentsPlan] échec sur un document :', resultat.reason?.message);
            continue;
        }
        const { doc, extrait } = resultat.value;
        if (!extrait.estPlanLogement) continue; // plan de masse/sous-sol/etc. — rien à comparer, pas un doute

        const problemes = [];
        if (extrait.surface != null && typeof lot.surface === 'number') {
            const ecart = Math.abs(extrait.surface - lot.surface);
            if (ecart >= SEUIL_ECART_SURFACE_M2 && ecart / lot.surface >= SEUIL_ECART_SURFACE_PCT) {
                problemes.push(`surface du plan (${extrait.surface} m²) très différente de la surface Otaree (${lot.surface} m²)`);
            }
        }
        if (extrait.typologie && lot.typology && extrait.typologie.toUpperCase() !== String(lot.typology).toUpperCase()) {
            problemes.push(`typologie du plan (${extrait.typologie}) différente de la typologie Otaree (${lot.typology})`);
        }
        if (problemes.length > 0) {
            return `Document "${doc.name}" possiblement erroné : ${problemes.join(', ')}.`;
        }
    }
    return null;
}

app.post('/api/verifier-plans', async (req, res) => {
    const { lot } = req.body || {};
    if (!lot || typeof lot !== 'object') return res.status(400).json({ success: false, error: 'lot requis' });
    try {
        const alerte = await verifierDocumentsPlan(lot);
        res.json({ success: true, alerte });
    } catch (error) {
        // Ne doit jamais bloquer le run — un échec ici équivaut à "rien à signaler".
        console.error('[api/verifier-plans] erreur :', error.message);
        res.json({ success: true, alerte: null });
    }
});

// Logins des 2 portails réels (voir DEFAULT_ESPACE_LOGIN/resoudreTokenPourEspace plus haut,
// mêmes valeurs déjà utilisées pour l'espace Hubiflow à la publication).
const PORTAIL_LOGIN_LMNP = 'ag762215';
const PORTAIL_LOGIN_NEUF = 'ag762216';

// Choisit le chemin de génération selon le PORTAIL DE DESTINATION réel (déjà résolu côté
// dashboard/server, voir resolvePortailsPourAnnonce), plutôt que de redétecter le dispositif
// fiscal ici — 2026-09-11, pour pouvoir brancher facilement un futur prompt Neuf dédié sans
// toucher au routage. Cas non ambigu (exactement un portail transmis, reconnu) : décision
// directe. Cas ambigu (0 ou 2+ portails transmis, ou info absente — voir
// resolvePortailsPourAnnonce, qui bascule vers TOUS les portails actifs quand le dispositif est
// indéterminé) : repli sur estLotLmnp(lot), exactement le comportement d'avant ce changement —
// garantit un résultat identique dans tous les cas, y compris ambigus, pas seulement le cas
// courant.
function choisirCheminGeneration(lot, portailLogins) {
    if (Array.isArray(portailLogins) && portailLogins.length === 1) {
        if (portailLogins[0] === PORTAIL_LOGIN_LMNP) return 'lmnp';
        if (portailLogins[0] === PORTAIL_LOGIN_NEUF) return 'neuf';
    }
    return estLotLmnp(lot) ? 'lmnp' : 'neuf';
}

app.post('/api/generate', async (req, res) => {
    try {
        const { lot, imagesSelection, portailLogins } = req.body || {};
        if (!lot || typeof lot !== 'object') return res.status(400).json({ success: false, error: 'lot requis' });

        const lotImageData = await downloadOtareeImages(lot, imagesSelection);
        const villeConnue = lot.program?.address?.city?.name || null;
        const codePostalConnu = lot.program?.address?.zipCode || null;

        // Prompt V2 dédié pour les lots LMNP (2/21/30/32) — titre+texte seulement, le reste des
        // champs structurés vient directement des données Otaree connues, jamais de l'IA. Tout
        // autre dispositif (Pinel, autres lois, Neuf) garde le prompt générique existant, mais
        // champsConnusDepuisLot() écrase désormais aussi ses champs structurés (étendu le
        // 2026-09-11 — jusque-là uniquement branché sur le chemin LMNP, ce qui laissait le
        // chemin générique deviner garage/terrasse/cave/box/loggia/DPE/adresse par l'IA, avec
        // les mêmes risques qu'avant l'extension LMNP : constaté en conditions réelles sur un
        // lot RP neuf/PTZ, "balcon" ressortait en chaîne de texte libre ("oui") plutôt qu'un
        // booléen fiable, et garage/cave/terrasse/loggia n'étaient même pas dans le schéma).
        // champsConnusDepuisLot() ne pose jamais une clé qu'il ne connaît pas avec certitude —
        // l'écraser en dernier ne fait donc que remplacer une supposition de l'IA par un fait
        // vérifié quand ce fait existe, jamais l'inverse.
        let aiData;
        let alerteConformite = null;
        let photoPrincipale = null;
        const chemin = choisirCheminGeneration(lot, portailLogins);
        if (chemin === 'lmnp') {
            const { titre, texte, photoPrincipale: photo, alerteConformite: alerte } = await callOpenAILmnp(buildTextContext(lot), lotImageData, lot);
            aiData = { ...champsConnusDepuisLot(lot), titre, texte };
            alerteConformite = alerte;
            photoPrincipale = photo;
        } else {
            // 'neuf' — prompt V1 dédié du client (voir PROMPT_SYSTEME_NEUF_V1, callOpenAINeuf),
            // remplace l'ancien chemin générique callOpenAI pour ce portail (2026-09-12).
            const { titre, texte, photoPrincipale: photo, alerteConformite: alerte } = await callOpenAINeuf(buildTextContext(lot), lotImageData, lot);
            aiData = { ...champsConnusDepuisLot(lot), titre, texte };
            alerteConformite = alerte;
            photoPrincipale = photo;
        }

        // Réordonne pour que la photo choisie par l'IA passe en premier — repli silencieux sur
        // l'ordre existant (déjà filtré/trié par downloadOtareeImages) si photoPrincipale est
        // null (aucune photo fournie, aucune ne s'est distinguée, ou nom invalide déjà écarté par
        // validerPhotoPrincipale) : jamais de réordonnancement sur une valeur non vérifiée.
        const imagesOrdonnees = photoPrincipale
            ? [...lotImageData].sort((a, b) => (a.name === photoPrincipale ? -1 : b.name === photoPrincipale ? 1 : 0))
            : lotImageData;
        const lotImages = imagesOrdonnees.map((img) => img.data);

        res.json({ success: true, aiData, images: lotImages, villeConnue, codePostalConnu, alerteConformite });
    } catch (error) {
        let errorMsg = error.message;
        if (error.response && error.response.data) errorMsg += ' - ' + JSON.stringify(error.response.data);
        res.status(500).json({ success: false, error: errorMsg });
    }
});

// Tarifs officiels par modèle (par token) — mis à jour au 5 septembre 2026, source
// developers.openai.com/api/docs/pricing. Sert au plafond de dépense (voir dashboard/server/
// src/services/depenseMonitor.js) : chaque appel réel enregistre son coût exact ici, pas une
// estimation a posteriori. gpt-4o corrigé au passage (était à 2,50$/10$, tarif obsolète depuis
// la baisse de prix de juillet 2026 — 1,25$/5$ actuel) : sans ça, callOpenAI (prompt générique,
// resté sur gpt-4o) aurait continué de surestimer sa dépense réelle de moitié.
const TARIFS_USD_PAR_TOKEN = {
    'gpt-4o': { entree: 1.25 / 1_000_000, sortie: 5.0 / 1_000_000 },
    'gpt-5-nano': { entree: 0.05 / 1_000_000, sortie: 0.4 / 1_000_000 },
};

async function enregistrerUsageOpenAI(usage, model = 'gpt-4o') {
    if (!usage) return;
    const tarif = TARIFS_USD_PAR_TOKEN[model] || TARIFS_USD_PAR_TOKEN['gpt-4o'];
    const coutUsd = usage.prompt_tokens * tarif.entree + usage.completion_tokens * tarif.sortie;
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

async function callOpenAI(textContext, base64Images, lot) {
    const systemPrompt = `Agis comme un expert immobilier de la loi Pinel et LMNP, rédacteur pour une agence haut de gamme. Tu dois lire ATTENTIVEMENT toutes les informations fournies (textes, documents extraits de PDF, ou plans en image) et en extraire un MAXIMUM de détails concrets et vérifiables pour rédiger une annonce précise, complète et jamais générique.

Ne cite JAMAIS le nom du promoteur (champ "developer" des données Otaree, ou tout nom de programme immobilier qui lui est associé) dans le texte de l'annonce, même s'il est connu et exact — utilise une formulation générique ("un promoteur reconnu", "ce programme immobilier neuf"...) si tu as besoin d'évoquer le développeur du bien. N'utilise jamais non plus les mots "sécurisé", "sécurisée", "sécuriser", "sécurité", "garanti", "garantie", "garantissant" ou "garantit" pour qualifier l'investissement, le placement, les revenus locatifs ou la rentabilité — ces mots restent acceptables uniquement pour un sens sans rapport avec l'investissement (ex: digicode, garantie décennale du bâtiment).

DPE — INTERDICTION STRICTE DE CHIFFRE INVENTÉ : si une étiquette DPE (une seule lettre A à G) est fournie dans les données du lot, tu peux mentionner cette lettre telle quelle. Tu ne dois JAMAIS inventer ou estimer une valeur chiffrée de consommation énergétique (ex: "137 kWh/m²/an") ni une lettre d'étiquette GES (émissions de gaz à effet de serre) — ces deux données ne sont jamais fournies dans ce pipeline. Si aucune lettre DPE n'est fournie, n'aborde pas le sujet de la performance énergétique.

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

    // NB : base64Images n'est volontairement pas rattaché à messageContent ici — comportement
    // préexistant inchangé (déjà le cas avant cette extension), pas dans le périmètre de cette
    // modification. Signalé séparément : le prompt mentionne pourtant "documents extraits de PDF,
    // ou plans en image" alors qu'aucune image n'est jamais envoyée au modèle sur ce chemin.
    const messageContent = [{ "type": "text", "text": "Voici les données extraites :\n\n" + (textContext || "(Aucun texte, base-toi sur les images)") }];

    const messages = [{ role: "system", content: systemPrompt }, { role: "user", content: messageContent }];

    // Même garde-fou que callOpenAILmnp (voir detecterProblemesConformite) — jusqu'ici absent de
    // ce chemin générique (Pinel, nue-propriété, autres dispositifs), alors que le prompt système
    // ci-dessus interdit désormais explicitement les mêmes formulations que le V2. Constaté en
    // conditions réelles (recherche Bordeaux) : 44/52 lots génériques publiés citaient le
    // promoteur ou une formulation interdite, sans aucun filet pour les rattraper.
    let resultat, hits = [];
    const MAX_TENTATIVES_CONFORMITE = 3;
    for (let essai = 1; essai <= MAX_TENTATIVES_CONFORMITE; essai++) {
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
                    messages,
                    temperature: 0.7,
                    max_tokens: 2000,
                    response_format: { type: 'json_object' },
                }, {
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
                    },
                    timeout: 60000,
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
        content = (content || '').replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
        try {
            resultat = JSON.parse(content);
        } catch (e) {
            throw new Error(`JSON.parse a échoué (finish_reason=${response.data.choices[0].finish_reason}, contenu brut="${content.substring(0, 200)}")`);
        }
        hits = detecterProblemesConformite(resultat.texte, lot);
        if (hits.length === 0) break;

        if (essai < MAX_TENTATIVES_CONFORMITE) {
            console.log(`[callOpenAI] formulation(s) interdite(s) détectée(s) (${hits.join(', ')}) — nouvelle tentative avec correction ciblée`);
            messages.push({ role: 'assistant', content: JSON.stringify(resultat) });
            messages.push({
                role: 'user',
                content: `Ta réponse précédente contient un problème détecté par notre vérification automatique : ${hits.join(', ')}.\n\nCorrige en appliquant EXACTEMENT l'une de ces substitutions (ne réinvente pas une reformulation différente) :\n${alternativesPourCorrection(hits, lot)}\n\nNe change rien d'autre au fond ni à la structure, et ne modifie AUCUN autre champ. Réponds à nouveau avec l'objet JSON complet dans EXACTEMENT le même format qu'avant (tous les champs présents), uniquement le texte concerné corrigé.`,
            });
        }
    }

    return { ...resultat, alerteConformite: hits.length > 0 ? hits : null };
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
        // donneesConnues.reference : référence générée/éditée sur l'écran de confirmation
        // (genererReferenceLmnp/genererReferenceNeuf, dashboard-server) — bug de transport
        // corrigé le 2026-09-13 : ce champ était calculé, affiché, éditable et persisté en base
        // côté dashboard depuis le début du chantier référencement LMNP, mais jamais transmis
        // jusqu'ici jusqu'à cette route, qui retombait donc TOUJOURS sur le défaut ci-dessous,
        // même pour un lot avec une vraie référence saisie. Utilisée telle quelle (déjà rendue
        // unique par rendreUnique côté dashboard, jamais de suffixe aléatoire supplémentaire ici).
        // Défaut (aucune référence connue) inchangé : préfixe dépendant du portail + suffixe
        // aléatoire — "LMNP" ou "PLUSIMO" selon le portail réel, voir commit du 2026-09-12.
        reference: donneesConnues.reference
            ? String(donneesConnues.reference)
            : (aiData.reference || (espaceLogin === PORTAIL_LOGIN_NEUF ? 'PLUSIMO' : 'LMNP')) + "-" + Math.floor(Math.random() * 10000),
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

    const hasTerrasse = bool(aiData.terrasse);
    if (hasTerrasse !== null) {
        annonce.terrasse = hasTerrasse;
        if (num(aiData.nb_terrasses) !== null) annonce.nb_terrasses = num(aiData.nb_terrasses);
        if (num(aiData.surface_terrasse) !== null) annonce.surface_terrasse = num(aiData.surface_terrasse);
    }

    // Nom de champ non vérifié directement dans le formulaire Hubiflow (pas d'accès à son
    // interface depuis ici) — suit la même convention que balcon/terrasse/garage (mot français
    // simple), à confirmer en pratique sur la première annonce réelle avec loggia.
    if (bool(aiData.loggia) !== null) annonce.loggia = bool(aiData.loggia);

    const hasParking = bool(aiData.parking);
    if (hasParking !== null) {
        annonce.possede_parking = hasParking;
        annonce.avec_stationnement = hasParking;
        if (num(aiData.nb_parkings) !== null) annonce.nb_parkings = num(aiData.nb_parkings);
    }

    const hasGarage = bool(aiData.garage);
    if (hasGarage !== null) {
        annonce.garage = hasGarage;
        if (num(aiData.nb_garages) !== null) annonce.nb_garages = num(aiData.nb_garages);
    }
    if (bool(aiData.box) !== null) annonce.box = bool(aiData.box);
    if (bool(aiData.cave) !== null) annonce.cave = bool(aiData.cave);

    if (num(aiData.surface_terrain) !== null) annonce.surface_terrain = num(aiData.surface_terrain);

    // Étage extrait depuis Otaree (champsConnusDepuisLot) mais jamais consommé ici jusqu'ici —
    // corrigé après l'inventaire des champs Hubiflow (2026-09-10).
    if (num(aiData.etage) !== null) annonce.etage = num(aiData.etage);

    if (aiData.latitude && !isNaN(parseFloat(aiData.latitude))) annonce.latitude = parseFloat(aiData.latitude);
    if (aiData.longitude && !isNaN(parseFloat(aiData.longitude))) annonce.longitude = parseFloat(aiData.longitude);

    // "Numéro de voie" et "Adresse" (nom de voie) — voir extraireNumeroVoie. La clé technique
    // réelle derrière le champ affiché "Adresse" est `nom_voie`, pas `adresse` — constaté en
    // conditions réelles (2026-09-11, lot Lyon "Cours Charlemagne") : envoyer via `adresse`
    // déclenche un ré-analyseur d'adresse côté Hubiflow qui reconnaît "Cours" comme un type de
    // voie et le sépare dans un champ `type_voie` interne, invisible sur ce formulaire — seul
    // `nom_voie` ("CHARLEMAGNE" seul) reste affiché, perdant le type de voie à l'écran alors
    // que rien n'a techniquement disparu côté API. Envoyer directement via `nom_voie` évite ce
    // ré-analyseur et préserve le texte intégral tel quel (vérifié : "COURS CHARLEMAGNE" reste
    // intact).
    if (aiData.numero_voie) annonce.numero_voie = String(aiData.numero_voie);
    if (aiData.adresse) annonce.nom_voie = String(aiData.adresse);

    if (aiData.exposition && typeof aiData.exposition === 'string' && aiData.exposition.toLowerCase() !== 'null') {
        annonce.exposition = aiData.exposition.toLowerCase().trim();
    }

    if (aiData.dpe_conso) annonce.dpe_etiquette_conso = aiData.dpe_conso;
    if (aiData.dpe_ges) annonce.dpe_etiquette_ges = aiData.dpe_ges;
    // Demande client (2026-09-11) : "Soumis au DPE" doit toujours avoir une réponse, jamais
    // laissé vide — "non" par défaut quand on ne sait pas (letter DPE absente), plutôt que
    // d'omettre le champ. Différent de dpe_etiquette_conso/ges eux-mêmes, qui restent omis tant
    // qu'aucune lettre n'est connue avec certitude (aucune invention sur CES champs-là).
    annonce.soumis_dpe = !!(aiData.dpe_conso || aiData.dpe_ges);
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
