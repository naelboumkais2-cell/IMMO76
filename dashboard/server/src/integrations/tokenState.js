// Lit l'état réel des tokens Hubiflow — directement dans la table `hubiflow_tokens`, alimentée
// par Ubiflow-Auto-API à chaque capture de token (voir Ubiflow-Auto-API/index.js, /api/token).
//
// Deux bugs corrigés ici le 2026-09-21, trouvés en investiguant un badge "espace non actif"
// toujours affiché en production :
//
// 1. Fichier local au lieu de la base partagée — la version précédente lisait
//    Ubiflow-Auto-API/token.json en supposant les deux services co-localisés sur le même disque,
//    faux depuis qu'ils tournent sur deux services Render séparés (containers distincts, aucun
//    disque partagé). Le fichier n'existe jamais côté dashboard-server, donc l'ancien
//    `getEspaceActif` retombait systématiquement sur son cas d'erreur silencieux — le badge
//    affichait TOUJOURS l'avertissement, qu'un espace soit réellement connecté ou non.
//
// 2. "Un seul espace actif à la fois" est une hypothèse fausse avec le format multi-token actuel
//    (`hubiflow_tokens`, une ligne par espace_login) : Ubiflow-Auto-API résout chaque token
//    indépendamment par son propre login (resoudreTokenPourEspace, `WHERE espace_login = ?`),
//    jamais par comparaison au "plus récent connecté". Preuve concrète : une publication LMNP a
//    réussi alors que l'espace Neuf était objectivement connecté plus récemment — les deux
//    espaces peuvent avoir un token valide simultanément (Chrome garde les deux sessions actives
//    séparément). Un portail est donc "actif" si SON PROPRE token existe et n'est pas expiré,
//    indépendamment de l'état des autres portails — jamais une notion exclusive.
import { db } from '../db.js';

function decoderExpirationJWT(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return payload.exp ? payload.exp * 1000 : null; // en ms
    } catch {
        return null;
    }
}

// { [espaceLogin]: { tokenPresent: true, expire: bool } } — un token absent pour un login donné
// n'apparaît simplement pas dans le résultat (équivalent à tokenPresent: false).
export async function getEtatsEspaces() {
    try {
        const rows = await db.prepare(`SELECT espace_login, token FROM hubiflow_tokens`).all();
        const etats = {};
        for (const row of rows) {
            const exp = decoderExpirationJWT(row.token);
            etats[row.espace_login] = { tokenPresent: true, expire: !!(exp && Date.now() > exp) };
        }
        return etats;
    } catch {
        return {};
    }
}
