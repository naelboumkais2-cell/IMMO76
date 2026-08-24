require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { db, initDb } = require('./db.js');

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

async function downloadOtareeImages(lot) {
    const images = Array.isArray(lot.images) ? lot.images : [];
    if (images.length === 0) return [];

    const sorted = [...images].sort((a, b) => {
        const an = (a.name || '').toLowerCase();
        const bn = (b.name || '').toLowerCase();
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

app.post('/api/generate', async (req, res) => {
    try {
        const { lot } = req.body || {};
        if (!lot || typeof lot !== 'object') return res.status(400).json({ success: false, error: 'lot requis' });

        const lotImageData = await downloadOtareeImages(lot);
        const lotImages = lotImageData.map(img => img.data);
        const villeConnue = lot.program?.address?.city?.name || null;
        const codePostalConnu = lot.program?.address?.zipCode || null;

        const aiData = await callOpenAI(buildTextContext(lot), lotImages);
        res.json({ success: true, aiData, images: lotImages, villeConnue, codePostalConnu });
    } catch (error) {
        let errorMsg = error.message;
        if (error.response && error.response.data) errorMsg += ' - ' + JSON.stringify(error.response.data);
        res.status(500).json({ success: false, error: errorMsg });
    }
});

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
        surface_habitable: (parseInt(aiData.surface) / 10).toString() || "0",
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
