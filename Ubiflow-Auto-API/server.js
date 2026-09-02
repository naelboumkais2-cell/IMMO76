require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const chokidar = require('chokidar');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Stockage EN COLLECTION des tokens interceptés — un par espace Ubiflow (ag762215/16/17...),
// sauvegardés dans token.json pour persistance. Le tag espaceLogin de chaque token vient de
// token_stealer.js, qui le décode directement du JWT (claim "username") — voir
// extension-chrome/Ubiflow-API-Companion/. token_stealer.js/content.js/background.js n'ont pas
// eu besoin de changer pour ça : ils envoyaient déjà { token, espaceLogin } par capture.
//
// /api/publish (flux extension/watcher, usage quotidien) garde le comportement d'avant : il
// utilise le "dernier espace connecté" (currentEspaceLogin), pas un espace choisi à la volée.
// /api/publish-payload (dashboard) peut cibler N'IMPORTE LEQUEL des espaces de la collection,
// peu importe l'ordre de connexion — c'est là que le vrai multi-portail se joue.
const TOKEN_FILE = './token.json';
// Repli si aucun tag n'est présent (très ancien token.json, ou token capturé par un
// token_stealer.js qui n'a pas su décoder le JWT) : on retombe sur l'espace utilisé jusqu'ici,
// pour ne rien casser silencieusement.
const DEFAULT_ESPACE_LOGIN = "ag762216";

let tokensParEspace = {}; // { [espaceLogin]: { token, date } }
let currentEspaceLogin = DEFAULT_ESPACE_LOGIN; // dernier espace connecté, pour /api/publish

function sauvegarderTokens() {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ tokens: tokensParEspace }, null, 2));
}

function chargerTokens() {
    if (!fs.existsSync(TOKEN_FILE)) return;
    try {
        const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));

        if (data.tokens) {
            // Nouveau format déjà en place.
            tokensParEspace = data.tokens;
            const plusRecent = Object.entries(tokensParEspace).sort(
                (a, b) => new Date(b[1].date) - new Date(a[1].date)
            )[0];
            if (plusRecent) currentEspaceLogin = plusRecent[0];
        } else if (data.token) {
            // Ancien format à plat (avant le multi-token) — migration en douceur : le token
            // existant devient la première entrée de la collection sous son espaceLogin (ou le
            // repli par défaut si l'ancien fichier n'avait pas encore ce tag), et le fichier est
            // réécrit immédiatement au nouveau format. Rien n'est perdu.
            const login = data.espaceLogin || DEFAULT_ESPACE_LOGIN;
            tokensParEspace = { [login]: { token: data.token, date: data.date || new Date().toISOString() } };
            currentEspaceLogin = login;
            sauvegarderTokens();
            console.log(`[🔑] token.json migré vers le format multi-espaces (espace existant : ${login})`);
        }

        console.log(
            `[🔑] Tokens rechargés depuis token.json (espaces connus : ${Object.keys(tokensParEspace).join(', ') || 'aucun'}) — dernier connecté : ${currentEspaceLogin}`
        );
    } catch (e) {
        console.log(`[⚠️] Impossible de lire token.json`);
    }
}

chargerTokens();

// Décode le claim "exp" d'un JWT (lecture locale, pas de vérification de signature — on ne
// s'en sert que pour détecter une expiration côté client avant d'appeler Hubiflow).
function decoderExpirationJWT(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return payload.exp ? payload.exp * 1000 : null; // en ms
    } catch (e) {
        return null;
    }
}

// Retrouve le token d'un espace précis dans la collection, avec vérification d'expiration —
// pour échouer vite et clairement plutôt que de laisser Hubiflow renvoyer un 401 confus.
function resoudreTokenPourEspace(espaceLogin) {
    const entry = tokensParEspace[espaceLogin];
    if (!entry) {
        return { erreur: `Aucun token connu pour l'espace ${espaceLogin} — connecte-toi dessus au moins une fois dans Chrome.` };
    }
    const exp = decoderExpirationJWT(entry.token);
    if (exp && Date.now() > exp) {
        const expireDepuisMin = Math.round((Date.now() - exp) / 60000);
        return {
            erreur: `Token pour l'espace ${espaceLogin} expiré depuis ${expireDepuisMin} min — reconnecte-toi sur cet espace dans Chrome.`
        };
    }
    return { token: entry.token };
}

// Informations d'agence communes à tous les espaces (contact affiché sur l'annonce, flux
// d'envoi) — ce n'est PAS l'identifiant de l'espace qui publie, celui-ci vient désormais du
// token actif (currentEspaceLogin), plus d'un seul portail supposé fixe.
const AGENCE_CONFIG = {
    contact_email: "cgalliot@plusimmo76.fr",
    contact_phone: "02 32 86 47 72",
    contact_address: "49 RUE JEANNE D ARC",
    contact_cp: "76000",
    contact_city: "ROUEN",
    flux_code: "SAISIE_IMMO"
};

// 1. Endpoint pour recevoir et sauvegarder le token depuis l'extension "Espion"
app.post('/api/token', (req, res) => {
    const { token, espaceLogin } = req.body;
    if (token) {
        const login = espaceLogin || DEFAULT_ESPACE_LOGIN;
        tokensParEspace[login] = { token, date: new Date().toISOString() };
        currentEspaceLogin = login; // "dernier connecté" — comportement de /api/publish inchangé
        sauvegarderTokens();
        console.log(`[🔑] Nouveau token Ubiflow intercepté (espace : ${login}) et sauvegardé dans token.json à ${new Date().toLocaleTimeString()}`);
        res.json({ success: true, message: 'Token sauvegardé', espaceLogin: login });
    } else {
        res.status(400).json({ success: false, message: 'Token manquant' });
    }
});

// Poste un payload déjà construit à l'API Hubiflow et met en forme la réponse (succès/erreur)
// de façon identique, que l'appelant vienne de /api/publish (génère aussi la description via
// IA) ou de /api/publish-payload (payload déjà prêt, sans appel IA) — un seul endroit qui parle
// à Hubiflow, pour ne pas faire diverger les deux endpoints avec le temps. Ne lève jamais :
// renvoie toujours { statusCode, body } pour que l'appelant fasse juste res.status(...).json(...).
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
            console.log(`[✅] Succès ! Annonce publiée (ID: ${response.data.ad.id})`);
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

        console.error(`[❌] Erreur retournée par Ubiflow:`, response.data);
        return { statusCode: 400, body: { success: false, error: 'Erreur retournée par Ubiflow', details: response.data } };

    } catch (error) {
        let errorMsg = error.message;
        let details = null;
        if (error.response) {
            console.error(`[❌] Erreur détaillée d'Ubiflow (Statut ${error.response.status}):`, JSON.stringify(error.response.data).substring(0, 500));
            details = error.response.data;
        }
        console.error(`[❌] Erreur serveur lors de la publication:`, errorMsg);
        return { statusCode: error.response ? error.response.status : 500, body: { success: false, error: errorMsg, details: details } };
    }
}

// 2. Endpoint principal pour générer et publier l'annonce
app.post('/api/publish', async (req, res) => {
    try {
        const { textContext, base64Images, villeConnue, codePostalConnu } = req.body;

        const resolu = resoudreTokenPourEspace(currentEspaceLogin);
        if (resolu.erreur) {
            return res.status(401).json({ success: false, error: resolu.erreur });
        }

        console.log(`[🧠] Début de l'analyse IA par OpenAI...`);
        const aiData = await callOpenAI(textContext, base64Images || []);
        console.log(`[🧠] Analyse IA terminée avec succès. Données extraites :`, JSON.stringify(aiData, null, 2));

        // villeConnue/codePostalConnu (extraits directement des données structurées Otaree,
        // ex: program.address.city.name) priment sur ce que l'IA a deviné : sur les lots avec
        // beaucoup de documents, l'IA peut se tromper de ville (ou recopier l'exemple du prompt)
        // en essayant de retrouver ce champ noyé dans un JSON volumineux.
        const payload = buildUbiflowPayload(aiData, base64Images || [], { ville: villeConnue, codePostal: codePostalConnu }, currentEspaceLogin);

        const { statusCode, body } = await envoyerAUbiflow(payload, resolu.token, currentEspaceLogin);
        res.status(statusCode).json(body);

    } catch (error) {
        let errorMsg = error.message;
        let details = null;
        if (error.response) {
            console.error(`[❌] Erreur détaillée d'Ubiflow (Statut ${error.response.status}):`, JSON.stringify(error.response.data).substring(0, 500));
            details = error.response.data;
        }
        console.error(`[❌] Erreur serveur lors de la publication:`, errorMsg);
        res.status(error.response ? error.response.status : 500).json({ success: false, error: errorMsg, details: details });
    }
});

// Active une annonce déjà créée (en brouillon) sur Hubiflow — PATCH séparé et léger, découvert
// par capture réseau réelle (pas dans buildUbiflowPayload/saveDraft, qui reste TOUJOURS un
// brouillon à la création, sans exception). Valeurs de STATUS confirmées empiriquement en
// lecture (GET /annonce/:id) : B = Brouillon, A = Actif, S = Supprimée.
//
// Body à 3 champs confirmé par une 2e capture réseau réelle (identique à la toute première,
// mal interprétée au départ comme "STATUS seul suffit") — le body minimal { annonce: { STATUS
// } } provoquait une 500 générique côté Hubiflow (confirmé en conditions réelles le
// 2026-08-18 : activation manuelle via l'UI Hubiflow réussie sur le même brouillon avec ce
// body complet, ce qui a écarté l'hypothèse d'un champ manquant sur l'ANNONCE elle-même comme
// DPE/photos). `annonceur.id` est l'identifiant NUMÉRIQUE de l'espace (ex: 762216), pas le
// login string ("ag762216") utilisé à la création — extrait du login par parseInt/regex.
// `flux.code` réutilise la même valeur fixe que buildUbiflowPayload (AGENCE_CONFIG.flux_code).
// adId nettoyé (parseInt) car les ids qui transitent par la base SQLite du dashboard reviennent
// parfois en flottant ("545534426.0") — l'URL Hubiflow n'accepte que l'entier.
async function activerAnnonceHubiflow(adId, token, espaceLogin) {
    const adIdPropre = parseInt(adId, 10);
    const annonceurId = parseInt(String(espaceLogin).replace(/\D/g, ''), 10);
    try {
        console.log(`[🌐] Activation de l'annonce ${adIdPropre} (espace ${espaceLogin}, annonceur.id=${annonceurId})...`);
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
        console.log(`[✅] Annonce ${adIdPropre} activée.`);
        return { success: true };
    } catch (error) {
        let errorMsg = error.message;
        if (error.response) {
            errorMsg += ' - ' + JSON.stringify(error.response.data).substring(0, 300);
        }
        console.error(`[❌] Erreur activation annonce ${adIdPropre}:`, errorMsg);
        return { success: false, error: errorMsg };
    }
}

// Retour arrière immédiat : dépublie/supprime une annonce sur Hubiflow. IMPORTANT : ce n'est
// PAS un PATCH STATUS:"S" symétrique à l'activation (testé, rejeté par Hubiflow avec une 500 —
// l'hypothèse initiale était fausse) — c'est une vraie requête HTTP DELETE sur la même URL.
// Confirmé empiriquement : DELETE .../annonce/{id} → 200, puis relecture GET confirme
// etat: "S" / etatAnnonce: "Supprimée". Utilisé par le bouton "Dépublier" de Supervision.jsx —
// chemin volontairement séparé et minimal (pas de dépendance à donnees_ia/aiData) pour rester
// rapide et fiable au moment où on en a besoin en urgence.
async function supprimerAnnonceHubiflow(adId, token, espaceLogin) {
    const adIdPropre = parseInt(adId, 10);
    try {
        console.log(`[🌐] Suppression de l'annonce ${adIdPropre} (espace ${espaceLogin})...`);
        await axios.delete(
            `https://espace-client-backend.ubiflow.net/annonce/${adIdPropre}?lang=fr`,
            {
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        console.log(`[✅] Annonce ${adIdPropre} supprimée.`);
        return { success: true };
    } catch (error) {
        let errorMsg = error.message;
        if (error.response) {
            errorMsg += ' - ' + JSON.stringify(error.response.data).substring(0, 300);
        }
        console.error(`[❌] Erreur suppression annonce ${adIdPropre}:`, errorMsg);
        return { success: false, error: errorMsg };
    }
}

app.post('/api/annonce/:id/depublier', async (req, res) => {
    const { espaceLoginAttendu } = req.body;
    if (!espaceLoginAttendu) {
        return res.status(400).json({ success: false, error: 'espaceLoginAttendu requis' });
    }
    const resolu = resoudreTokenPourEspace(espaceLoginAttendu);
    if (resolu.erreur) {
        return res.status(401).json({ success: false, error: resolu.erreur });
    }
    const result = await supprimerAnnonceHubiflow(req.params.id, resolu.token, espaceLoginAttendu);
    res.status(result.success ? 200 : 502).json(result);
});

// Lecture seule : renvoie l'état RÉEL d'une annonce sur Hubiflow (etat: "B"/"A"/"S"), pour
// resynchroniser le dashboard si un changement a été fait directement sur Hubiflow (hors de ce
// pipeline) — ex: quelqu'un repasse une annonce en brouillon depuis l'interface Hubiflow.
// Aucun effet de bord, un simple GET /annonce/:id.
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
        if (error.response) {
            errorMsg += ' - ' + JSON.stringify(error.response.data).substring(0, 300);
        }
        console.error(`[❌] Erreur lecture état annonce ${adIdPropre}:`, errorMsg);
        return { success: false, error: errorMsg };
    }
}

app.get('/api/annonce/:id/etat', async (req, res) => {
    const { espaceLoginAttendu } = req.query;
    if (!espaceLoginAttendu) {
        return res.status(400).json({ success: false, error: 'espaceLoginAttendu requis' });
    }
    const resolu = resoudreTokenPourEspace(espaceLoginAttendu);
    if (resolu.erreur) {
        return res.status(401).json({ success: false, error: resolu.erreur });
    }
    const result = await lireEtatAnnonceHubiflow(req.params.id, resolu.token);
    res.status(result.success ? 200 : 502).json(result);
});

// 2bis. Endpoint additif : publie un aiData déjà construit (pas d'appel OpenAI ici) — utilisé
// par le dashboard, dont les annonces mockées ont déjà des données "prêtes". Ne modifie rien
// au comportement de /api/publish ci-dessus.
//
// `mode` ('brouillon' par défaut, ou 'actif') : la création est TOUJOURS un brouillon d'abord
// (aucun changement à buildUbiflowPayload/saveDraft, donc aucun risque ajouté à cette étape).
// Si mode === 'actif' ET que la création a réussi, un second appel PATCH active l'annonce déjà
// créée. Si cette activation échoue, on renvoie quand même success:true (le brouillon existe
// bel et bien sur Hubiflow, pas de doublon à créer en cas de retry) avec actif:false et
// erreurActivation, pour que l'appelant puisse distinguer "brouillon créé, pas encore activé"
// d'une vraie publication complète.
app.post('/api/publish-payload', async (req, res) => {
    const { aiData, base64Images, villeConnue, codePostalConnu, espaceLoginAttendu, mode } = req.body;

    if (!espaceLoginAttendu) {
        return res.status(400).json({ success: false, error: 'espaceLoginAttendu requis' });
    }
    if (!aiData) {
        return res.status(400).json({ success: false, error: 'aiData manquant' });
    }

    // Vrai multi-portail : va chercher le token de l'espace demandé dans la collection, peu
    // importe l'ordre de connexion — plus de contrainte "doit être l'espace le plus récemment
    // connecté" (c'était la limite de l'option A, remplacée par le multi-token de l'option B).
    const resolu = resoudreTokenPourEspace(espaceLoginAttendu);
    if (resolu.erreur) {
        return res.status(401).json({ success: false, error: resolu.erreur });
    }

    const payload = buildUbiflowPayload(aiData, base64Images || [], { ville: villeConnue, codePostal: codePostalConnu }, espaceLoginAttendu);
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

// 2ter. Endpoint additif : génère aiData + images pour un lot Otaree, SANS publier — la
// première moitié de processOtareeFolder (downloadOtareeImages -> buildTextContext ->
// callOpenAI), extraite ici pour être appelable directement sur un lot reçu par API (pas
// un dossier Downloads). Utilisé par dashboard/ pour l'auto-publication depuis otaree-search
// (AUTO_PUBLISH) — processOtareeFolder et /api/publish restent inchangés, aucune duplication
// du prompt IA, juste réutilisation des mêmes fonctions.
app.post('/api/generate', async (req, res) => {
    try {
        const { lot } = req.body || {};
        if (!lot || typeof lot !== 'object') {
            return res.status(400).json({ success: false, error: 'lot requis' });
        }

        const lotImageData = await downloadOtareeImages(lot);
        const lotImages = lotImageData.map(img => img.data);

        const villeConnue = lot.program?.address?.city?.name || null;
        const codePostalConnu = lot.program?.address?.zipCode || null;

        const aiData = await callOpenAI(buildTextContext(lot), lotImages);

        res.json({ success: true, aiData, images: lotImages, villeConnue, codePostalConnu });
    } catch (error) {
        let errorMsg = error.message;
        if (error.response && error.response.data) {
            errorMsg += ' - ' + JSON.stringify(error.response.data);
        }
        console.error(`[❌] Erreur /api/generate:`, errorMsg);
        res.status(500).json({ success: false, error: errorMsg });
    }
});

async function callOpenAI(textContext, base64Images) {
    const systemPrompt = `Agis comme un expert immobilier de la loi Pinel et LMNP, rédacteur pour une agence haut de gamme. Tu dois lire ATTENTIVEMENT toutes les informations fournies (textes, documents extraits de PDF, ou plans en image) et en extraire un MAXIMUM de détails concrets et vérifiables pour rédiger une annonce précise, complète et jamais générique.
Renvoie UNIQUEMENT un objet JSON strictement conforme à la structure suivante, sans aucun markdown ni texte autour :
{
  "titre": "RÈGLE : le titre doit être SOBRE et FACTUEL comme une vraie annonce immobilière rédigée par un agent, PAS un slogan marketing IA. INTERDIT : les mots 'Investissement', 'Investissez', 'LMNP', 'rentable', 'rentabilité', points d'exclamation, et toute promesse ('opportunité unique', 'ne manquez pas', 'idéal pour'). Ne présuppose JAMAIS le profil de l'acheteur (pas 'idéal étudiant' ni 'parfait investisseur') — le titre décrit le BIEN, pas sa cible. Structure à utiliser, en choisissant TOI-MÊME l'élément le plus pertinent/distinctif de CE lot précis (pas toujours le même type d'info d'une annonce à l'autre) : [Type de bien] + [ville ou quartier] + UN détail marquant réellement notable pour ce lot (au choix selon ce qui est le plus pertinent : surface si notable, étage élevé avec vue, balcon/terrasse, proximité d'un lieu précis, exposition, nom de résidence si vendeur). Exemples de ton juste (à ne pas recopier) : 'Studio 18m² au Havre, quartier gare', 'Appartement T1 avec balcon à Rouen', 'Studio dernier étage, résidence Twenty Campus'. Reste concis (max 60 caractères).",
  "titre_alternatif": "Version encore plus courte du même titre factuel (max 40 caractères), sans mot marketing, sans 'investissement'",
  "texte_resume": "Une phrase factuelle et concise résumant le bien (pas d'accroche commerciale, pas de superlatif)",
  "texte": "RÈGLE ABSOLUE : N'utilise QUE des informations réellement présentes dans les données fournies. N'invente JAMAIS un détail (pas de 'RT2012', 'garantie décennale', 'aucun travaux', 'stationnement', etc. sauf si ce point est explicitement mentionné dans les données). Une phrase générique qui pourrait s'appliquer à n'importe quel bien est INTERDITE. \\n\\nFORME OBLIGATOIRE — calque EXACTEMENT le style des annonces professionnelles ci-dessous (ce sont de vraies annonces actives et efficaces de l'agence, imite leur ton, leur rythme et leur mise en page) : \\n- JAMAIS de balises HTML ni de gras (pas de <b>). Texte brut uniquement.\\n- JAMAIS de titres de section, de numéros ou de libellés ('INTRODUCTION', '1)'...). Uniquement des paragraphes rédigés.\\n- Paragraphes COURTS (2 à 4 phrases chacun), séparés par une ligne vide entre chaque paragraphe (\\\\n\\\\n) — le texte doit être très aéré, jamais un pavé compact.\\n- Phrases fluides et naturelles, jamais de liste à puces sauf si le bien a vraiment beaucoup de caractéristiques distinctes à énumérer (comme une maison avec de nombreuses prestations).\\n\\nSTRUCTURE À SUIVRE, dans cet ordre, en n'incluant que les paragraphes où tu as une vraie donnée : \\n1. Accroche d'ouverture : 'Découvrez ce/cet [typologie] de [surface] m², situé [adresse/quartier précis si connu] à [ville].'\\n2. Agencement : 'Bien agencé / Fonctionnel et agréable à vivre, il se compose de [pièces en une phrase fluide, pas une liste].' Va chercher un MAXIMUM de détails concrets sur ce que contient réellement le bien si les documents les mentionnent (type de cuisine, mobilier fourni et sa valeur, équipements, finitions, matériaux, DPE/classe énergie, exposition) — ce sont ces détails précis qui donnent envie, pas des formules vagues.\\n3. Extérieur si balcon/terrasse/jardin PRÉSENT : un court paragraphe dédié. Si absent ou inconnu, ne mentionne RIEN à ce sujet (n'écris jamais 'pas de balcon' ou 'ne dispose pas de' — omets complètement le sujet).\\n4. Stationnement si PRÉSENT : un court paragraphe dédié (peut être fusionné avec le précédent). Si absent ou inconnu, ne mentionne RIEN à ce sujet (jamais de tournure négative).\\n5. Si des infos de commission/rémunération existent dans les données : intègre-les dans une phrase naturelle, sans gras, avec les montants exacts.\\n6. Les données financières et de gestion (prix, rendement/rentabilité, loyer, gestionnaire, durée de bail, fiscalité LMNP) en phrase fluide avec tous les chiffres disponibles.\\n7. Localisation : quartier/rue/transports/commerces UNIQUEMENT si des éléments précis et réels sont fournis dans les données (jamais de généralité vague).\\n8. Une phrase sur le profil d'acquéreur idéal si pertinent (investisseur LMNP, etc.).\\n9. Prix, si connu, en paragraphe autonome et court : 'Prix : XX XXX €'.\\n10. Appel à l'action final avec le téléphone de contact : 'Contactez-nous pour plus d'informations au 02 32 86 47 72' (ou variante 'pour organiser une visite', 'pour recevoir le plan du lot', etc.).\\n\\nEXEMPLES RÉELS À IMITER POUR LE STYLE (mise en page, longueur de phrase, ton) — ne recopie jamais leur contenu, seulement leur manière d'écrire :\\n\\nExemple 1 : 'Découvrez cet appartement 2 pièces d'environ 39 m², situé au 1er étage d'une résidence contemporaine à Fleury-sur-Orne.\\\\n\\\\nBien agencé, il se compose d'une pièce de vie lumineuse avec cuisine ouverte, d'une chambre confortable et d'une salle d'eau.\\\\n\\\\nLe séjour se prolonge par un balcon, idéal pour profiter des beaux jours. Une place de stationnement extérieure complète ce bien.\\\\n\\\\nLa résidence bénéficie d'un emplacement recherché, route d'Harcourt, au sud de Caen. Le centre-ville, les commerces et les principaux pôles d'emploi de l'agglomération sont rapidement accessibles.\\\\n\\\\nCet appartement conviendra parfaitement à un premier achat, à un couple ou à un projet d'investissement locatif.\\\\n\\\\nPrix : 159 000 €\\\\n\\\\nContactez-nous pour recevoir le plan du lot et obtenir davantage d'informations.'\\n\\nExemple 2 (studio) : 'Découvrez ce studio de 23 m², situé impasse Caron à Rouen à proximité du centre-ville.\\\\n\\\\nFonctionnel et agréable à vivre, l'appartement se compose d'une pièce de vie pouvant accueillir un espace salon, la cuisine, une salle d'eau ainsi qu'un coin nuit à l'étage.\\\\n\\\\nSon principal atout est son jardin privatif d'environ 4 m², un espace extérieur appréciable pour profiter des beaux jours.\\\\n\\\\nUne place de stationnement complète ce bien, un véritable avantage dans un secteur urbain.\\\\n\\\\nLes points forts : studio de 23 m², jardin privatif, stationnement, adresse rouennaise et proximité du centre-ville.\\\\n\\\\nContactez-nous pour organiser une visite et obtenir davantage d'informations.'\\n\\nAdapte cette structure et ce ton à un bien LMNP/Pinel en gardant EXACTEMENT la même aération et la même sobriété.",
  "reference": "Reference extraite du texte (ex: B813-0B538DFE1892)",
  "prix": "Le prix total (nombre entier, ex: 84200)",
  "surface": "La surface totale (nombre entier en dixièmes de m2, ex: pour 17.17m2 -> 177)",
  "pieces": "Nombre de pièces (nombre entier, ex: 1 si T1, 2 si T2)",
  "etage": "Étage (nombre entier, mettre 0 si RDC, ou estimer à 1 si inconnu)",
  "code_postal": "Code postal extrait (ex: 76000)",
  "ville": "Ville extraite (ex: Rouen)",
  "date_livraison": "Date de livraison/actabilité au format DD/MM/YYYY si présente, sinon la date du jour",
  "surface_sejour": "Surface du séjour en m2 (nombre, ex: 23), null si non trouvée dans les données",
  "nb_chambres": "Nombre de chambres (nombre entier). Si les données Otaree donnent 'roomsCount', utilise cette valeur. null si vraiment inconnu",
  "nb_salles_d_eau": "Nombre de salles de bain/douche (nombre entier), null si inconnu",
  "nb_wc": "Nombre de WC (nombre entier), null si inconnu",
  "balcon": "true si le bien a un balcon ou une terrasse (ex: si 'terraceSurface' > 0 dans les données Otaree), false si explicitement absent, null si inconnu",
  "nb_balcons": "Nombre de balcons/terrasses (nombre entier), null si inconnu",
  "surface_balcon": "Surface du balcon/terrasse en m2 (nombre entier, ex: si terraceSurface Otaree existe utilise cette valeur), null si inconnu",
  "parking": "true si le bien a un parking (ex: si 'parkingCount' > 0 dans les données Otaree), false si explicitement absent, null si inconnu",
  "nb_parkings": "Nombre de places de parking (nombre entier, ex: la valeur 'parkingCount' d'Otaree si présente), null si inconnu",
  "exposition": "Exposition du bien en minuscules parmi: nord, sud, est, ouest, nord-est, nord-ouest, sud-est, sud-ouest. null si inconnue",
  "dpe_conso": "Lettre DPE de consommation énergétique (A à G, ex: la valeur 'energyClass' d'Otaree si présente), null si inconnue",
  "dpe_ges": "Lettre DPE d'émission de gaz à effet de serre (A à G), null si inconnue",
  "proche_commerces": "true si le texte mentionne explicitement une proximité de commerces/magasins, sinon null (ne pas inventer)"
}`;

    let messageContent = [
        {
            "type": "text",
            "text": "Voici les données extraites :\n\n" + (textContext || "(Aucun texte, base-toi sur les images)")
        }
    ];

    /*
    // Les images sont trop lourdes pour OpenAI et font crasher l'API avec l'erreur "context_length_exceeded".
    // On les retire de l'analyse, l'IA se basera uniquement sur le texte JSON.
    base64Images.slice(0, 5).forEach(base64 => {
        if (base64.startsWith("data:image/")) {
            messageContent.push({
                "type": "image_url",
                "image_url": { "url": base64 }
            });
        }
    });
    */

    const response = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: messageContent }
        ],
        temperature: 0.7,
        max_tokens: 2000
    }, {
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        }
    });

    let content = response.data.choices[0].message.content;
    content = content.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
    return JSON.parse(content);
}

function buildUbiflowPayload(aiData, base64Images = [], donneesConnues = {}, espaceLogin) {
    const annonce = {
        communiquer_adresse_exacte: "oui",
        nbDiffusions: 0,
        typeOffre: "V", // Vente
        typeObjet: 1100, // 1100 = Appartement (ou 1000 = Maison)
        photos: base64Images.map(b64 => ({ type: "base64", url: b64 })),
        contact_a_afficher: "La Centrale du Neuf Plusimmo",
        email_a_afficher: "accueil@plusimmo76.fr",
        telephone_a_afficher: "02 32 86 47 72",
        telephone_mobile_a_afficher: "",
        adresse_contact_a_afficher: "49 RUE JEANNE D ARC",
        code_postal_contact_a_afficher: "76000",
        ville_contact_a_afficher: "ROUEN",
        id_contact_a_afficher: 146265, // <-- Le fameux ID du contact manquant !
        devise_iso_4217: "EUR",
        afficher_prix: "oui",
        reference: (aiData.reference || "LMNP") + "-" + Math.floor(Math.random() * 10000),
        titre: aiData.titre || "Annonce LMNP",
        titre_alternatif: aiData.titre_alternatif || aiData.titre || "Annonce LMNP",
        texte_resume: aiData.texte_resume || "",
        localText: aiData.texte || "Description à rédiger",
        texte: aiData.texte || "Description à rédiger",
        prix: parseInt(aiData.prix) || 0,
        surface_habitable: (parseInt(aiData.surface) / 10).toString() || "0",
        nb_pieces_logement: parseInt(aiData.pieces) || 1,
        // Priorité à la donnée structurée Otaree (donneesConnues), fiable à 100% quand elle existe.
        // Sur les lots avec beaucoup de documents, l'IA peut se tromper de ville en essayant de la
        // retrouver dans un JSON volumineux (voire recopier l'exemple du prompt par défaut).
        code_postal_reel: donneesConnues.codePostal
            ? String(donneesConnues.codePostal)
            : (aiData.code_postal && aiData.code_postal !== "00000" && !String(aiData.code_postal).toLowerCase().includes("inconnu")) ? String(aiData.code_postal) : "76000",
        ville_reelle: donneesConnues.ville
            ? String(donneesConnues.ville)
            : (aiData.ville && !String(aiData.ville).toLowerCase().includes("inconnu")) ? String(aiData.ville) : "Rouen",
        visite_dateVisite: null,
        visite_horaireVisite: null,
        visite_nbPersonne: null
    };

    // Caractéristiques structurées (section "Offer description" côté Ubiflow) :
    // on ne renseigne un champ QUE si l'IA a trouvé une vraie valeur, pour ne jamais afficher
    // une caractéristique fausse (ex: "pas de balcon" alors que l'info est juste inconnue).
    const num = (v) => (v === null || v === undefined || v === '' || isNaN(parseInt(v))) ? null : parseInt(v);
    const bool = (v) => (v === true || v === false) ? v : null;

    const surfaceSejour = num(aiData.surface_sejour);
    if (surfaceSejour !== null) annonce.surface_sejour = surfaceSejour;

    const nbChambres = num(aiData.nb_chambres);
    if (nbChambres !== null) annonce.nombre_de_chambres = nbChambres;

    const nbSallesDEau = num(aiData.nb_salles_d_eau);
    if (nbSallesDEau !== null) annonce.nb_salles_d_eau = nbSallesDEau;

    const nbWc = num(aiData.nb_wc);
    if (nbWc !== null) annonce.nb_wc = nbWc;

    const hasBalcon = bool(aiData.balcon);
    if (hasBalcon !== null) {
        annonce.balcon = hasBalcon;
        const nbBalcons = num(aiData.nb_balcons);
        if (hasBalcon && nbBalcons !== null) annonce.nb_balcons = nbBalcons;
        const surfaceBalcon = num(aiData.surface_balcon);
        if (hasBalcon && surfaceBalcon !== null) annonce.surface_balcon = surfaceBalcon;
    }

    const hasParking = bool(aiData.parking);
    if (hasParking !== null) {
        annonce.possede_parking = hasParking;
        annonce.avec_stationnement = hasParking;
        const nbParkings = num(aiData.nb_parkings);
        if (hasParking && nbParkings !== null) annonce.nb_parkings = nbParkings;
    }

    if (aiData.exposition && typeof aiData.exposition === 'string' && aiData.exposition.toLowerCase() !== 'null') {
        annonce.exposition = aiData.exposition.toLowerCase().trim();
    }

    const dpeConso = (aiData.dpe_conso && /^[A-G]$/i.test(aiData.dpe_conso)) ? aiData.dpe_conso.toUpperCase() : null;
    const dpeGes = (aiData.dpe_ges && /^[A-G]$/i.test(aiData.dpe_ges)) ? aiData.dpe_ges.toUpperCase() : null;
    if (dpeConso) annonce.dpe_etiquette_conso = dpeConso;
    if (dpeGes) annonce.dpe_etiquette_ges = dpeGes;
    if (dpeConso || dpeGes) annonce.soumis_dpe = true;

    const procheCommerces = bool(aiData.proche_commerces);
    if (procheCommerces !== null) annonce.proche_commerces = procheCommerces;

    return {
        action: "saveDraft",
        universe: "IMMO",
        annonce,
        flux: {
            code: AGENCE_CONFIG.flux_code
        },
        annonceur: {
            login: espaceLogin
        }
    };
}

const PORT = 4000;
app.listen(PORT, () => {
    console.log(`[🚀] API Ubiflow Automatisée V 1.1.3 démarrée sur http://localhost:${PORT}`);
    console.log(`[ℹ️] Espaces connus : ${Object.keys(tokensParEspace).join(', ') || 'aucun'} — dernier connecté : ${currentEspaceLogin}`);
    startWatcher();
});

function startWatcher() {
    const downloadsPath = path.join(os.homedir(), 'Downloads');
    console.log(`[👀] Démarrage de l'Observateur (Watcher) sur ${downloadsPath}...`);
    
    const watcher = chokidar.watch(downloadsPath, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        depth: 0,
        ignoreInitial: true
    });

    watcher.on('addDir', (dirPath) => {
        const dirName = path.basename(dirPath);
        if (dirName.startsWith('Lots_Otaree_Export_')) {
            console.log(`\n======================================================`);
            console.log(`[📁] Nouveau lot Otaree détecté : ${dirName}`);
            console.log(`[⏳] Attente de 15 secondes pour l'extraction complète du lot...`);
            setTimeout(() => {
                enqueueFolder(dirPath);
            }, 15000);
        }
    });
}

// File d'attente : traite les dossiers UN PAR UN.
// Sans ça, un export en masse (plusieurs dossiers détectés d'un coup) lance plusieurs
// traitements en parallèle qui se font concurrence sur le réseau (CloudFront, OpenAI, Ubiflow)
// et peuvent faire échouer silencieusement certains téléchargements d'images.
let folderQueue = Promise.resolve();
function enqueueFolder(dirPath) {
    folderQueue = folderQueue
        .then(() => processOtareeFolder(dirPath))
        .catch(e => console.error(`[❌] Erreur file d'attente pour ${dirPath}:`, e.message));
}

// Construit le texte envoyé à l'IA à partir d'un lot Otaree, en retirant ce qui n'apporte
// aucun signal utile mais fait exploser la taille du prompt : les URLs signées (images,
// documents) et tout contenu de fichier volumineux. Certains lots ont 60+ documents
// attachés (baux, PV d'AG, diagnostics...) ; leurs métadonnées (nom/type) suffisent à
// l'IA pour savoir qu'ils existent, pas besoin de leur contenu intégral.
// Filet de sécurité final : troncature dure si, malgré tout, le texte reste trop long
// pour tenir dans la fenêtre de contexte du modèle avec le reste du prompt.
const TEXT_CONTEXT_MAX_CHARS = 60000; // ~15-18k tokens, large marge sous la limite de 128k

function buildTextContext(lot) {
    const allege = { ...lot };

    if (Array.isArray(allege.images)) {
        allege.images = allege.images.map(img => ({ name: img.name, mimeType: img.mimeType }));
    }
    if (Array.isArray(allege.documents)) {
        allege.documents = allege.documents.map(doc => ({
            type: doc.type,
            name: doc.file?.name || doc.name || null,
        }));
    }

    let text = JSON.stringify(allege, null, 2);
    if (text.length > TEXT_CONTEXT_MAX_CHARS) {
        text = text.slice(0, TEXT_CONTEXT_MAX_CHARS) + '\n... (contenu tronqué, trop volumineux)';
    }
    return text;
}

// Télécharge les images d'un lot depuis les URLs Otaree (champ "images" du JSON) et les convertit en base64.
// Retourne un tableau [{ name, data }] où data est un data-URI utilisable directement par Ubiflow.
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

    // Trier : perspectives (extérieures) en premier, comme pour les fichiers locaux
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
    const seenHashes = new Set(); // pour éviter d'envoyer des doublons (Otaree renvoie parfois la même image)
    for (const img of sorted) {
        if (result.length >= 20) break; // limite à 20 photos
        // Otaree mélange parfois des documents (plans PDF...) dans le même tableau que les photos ;
        // mimeType est fiable pour les exclure (contrairement au content-type CloudFront de l'URL, lui erroné).
        if (img.mimeType && !img.mimeType.startsWith('image/')) continue;
        const url = img.urls && (img.urls.large || img.urls.medium || img.urls.medium_fit || img.urls.small);
        if (!url) continue;
        // Jusqu'à 3 tentatives : un timeout/reset réseau ponctuel ne doit pas faire perdre la photo.
        let buf = null;
        for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
            try {
                const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
                buf = Buffer.from(resp.data);
            } catch (e) {
                if (attempt === 3) {
                    console.log(`[⚠️] Image Otaree non téléchargée après 3 essais (${(img.name || url).substring(0, 40)}): ${e.message}`);
                } else {
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
            }
        }
        if (!buf) continue;

        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        if (seenHashes.has(hash)) continue; // doublon : on saute
        seenHashes.add(hash);
        const b64 = buf.toString('base64');
        // Les variantes Otaree sont des JPEG ; on force image/jpeg (CloudFront renvoie un content-type erroné)
        const mime = (img.mimeType && img.mimeType.startsWith('image/')) ? img.mimeType : 'image/jpeg';
        result.push({ name: (img.name || 'image').toLowerCase(), data: `data:${mime};base64,${b64}` });
    }
    if (result.length > 0) {
        console.log(`[🖼️] ${result.length}/${images.length} image(s) Otaree téléchargée(s) depuis le JSON.`);
    }
    return result;
}

async function processOtareeFolder(folderPath) {
    try {
        console.log(`[⚙️] Traitement du lot : ${folderPath}`);
        const files = fs.readdirSync(folderPath);
        const jsonFile = files.find(f => f.endsWith('.json') && f.startsWith('otaree_full_extract_'));
        
        if (!jsonFile) {
            console.log(`[⚠️] Aucun fichier JSON trouvé dans ${folderPath}.`);
            return;
        }

        const jsonPath = path.join(folderPath, jsonFile);
        const otareeData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const lotsArray = Array.isArray(otareeData) ? otareeData : [otareeData];
        
        for (const lot of lotsArray) {
            const number = lot.number || 'Inconnu';
            const lot_id = lot.id || 'Inconnu';
            const lotDir = path.join(folderPath, `Lot_${number}_${lot_id}`);
            
            let lotImageData = [];

            // SOURCE 1 (prioritaire) : les URLs d'images fournies par Otaree dans le JSON.
            // C'est la source fiable : toujours présente même si les fichiers ne sont pas téléchargés.
            lotImageData = await downloadOtareeImages(lot);

            // SOURCE 2 (repli) : si aucune image dans le JSON, on scanne les fichiers du dossier du lot.
            if (lotImageData.length === 0 && fs.existsSync(lotDir)) {
                const searchImages = (dir) => {
                    const items = fs.readdirSync(dir, { withFileTypes: true });
                    for (const item of items) {
                        const fullPath = path.join(dir, item.name);
                        if (item.isDirectory()) {
                            searchImages(fullPath);
                        } else {
                            const ext = path.extname(item.name).toLowerCase();
                            if (['.jpg', '.jpeg', '.png'].includes(ext) && lotImageData.length < 20) {
                                const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
                                const b64Data = fs.readFileSync(fullPath, 'base64');
                                lotImageData.push({
                                    name: item.name.toLowerCase(),
                                    data: `data:${mime};base64,${b64Data}`
                                });
                            }
                        }
                    }
                };
                searchImages(lotDir);

                // Trier les fichiers locaux : perspectives (extérieures) en premier
                lotImageData.sort((a, b) => {
                    const aIsExt = a.name.includes('perspective') || a.name.includes('exterieur');
                    const bIsExt = b.name.includes('perspective') || b.name.includes('exterieur');
                    if (aIsExt && !bIsExt) return -1;
                    if (!aIsExt && bIsExt) return 1;
                    return a.name.localeCompare(b.name);
                });
            }

            const lotImages = lotImageData.map(img => img.data);

            // Ville/code postal fiables, lus directement dans les données structurées Otaree
            // plutôt que laissés à l'IA (qui peut se tromper sur les lots à gros volume de documents).
            const villeConnue = lot.program?.address?.city?.name || null;
            const codePostalConnu = lot.program?.address?.zipCode || null;

            const testData = {
                textContext: buildTextContext(lot),
                base64Images: lotImages,
                villeConnue,
                codePostalConnu
            };

            console.log(`[🚀] Envoi du lot ${number} (avec ${lotImages.length} images) à l'API interne pour publication...`);
            try {
                const response = await axios.post(`http://localhost:${PORT}/api/publish`, testData);
                console.log(`[✅] Lot ${number} automatisé avec succès ! ID Annonce: ${response.data.adId}`);
            } catch (err) {
                console.error(`[❌] Erreur lors du lot ${number} :`, err.response ? JSON.stringify(err.response.data) : err.message);
            }
            console.log(`======================================================\n`);
        }

    } catch (error) {
        let msg = error.message;
        if (error.response && error.response.data) {
            msg += ' - ' + JSON.stringify(error.response.data);
        }
        console.error(`[❌] Erreur lors du traitement automatique du lot :`, msg);
        console.log(`======================================================\n`);
    }
}
