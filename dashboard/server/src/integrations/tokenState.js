// Lit l'état réel du token Hubiflow actif — directement dans la table `hubiflow_tokens`, alimentée
// par Ubiflow-Auto-API à chaque capture de token (voir Ubiflow-Auto-API/index.js, /api/token).
//
// Corrige un bug réel trouvé le 2026-09-21 : la version précédente lisait un fichier local
// (Ubiflow-Auto-API/token.json) en supposant les deux services co-localisés sur le même disque —
// une hypothèse fausse depuis qu'ils tournent sur deux services Render séparés (containers
// distincts, aucun disque partagé). Résultat en production : le fichier n'existe jamais côté
// dashboard-server, `getEspaceActif` retombait systématiquement sur son cas d'erreur silencieux
// (espaceLogin: null) — le badge "espace non actif" de Supervision.jsx affichait donc TOUJOURS cet
// avertissement, qu'un espace soit réellement connecté ou non (faux négatif permanent).
//
// La vraie source de vérité partagée entre les deux services n'est pas le disque, mais la même
// base Postgres (voir CLAUDE.md — un seul Neon partagé) : `hubiflow_tokens` y est déjà la table
// que Ubiflow-Auto-API lit lui-même pour résoudre un token par espace (resoudreTokenPourEspace).
// La lire directement ici élimine le couplage fragile par fichier, sans dépendre d'un appel HTTP
// vers l'autre service (latence/disponibilité en moins à gérer pour un simple affichage).
//
// "Actif" signifie désormais : le dernier espace connecté (même sens qu'avant) ET dont le token
// n'est pas expiré — un token expiré ne permettrait de toute façon aucune publication réelle,
// donc l'afficher comme "actif" serait trompeur.
import { db } from '../db.js';

function decoderExpirationJWT(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return payload.exp ? payload.exp * 1000 : null; // en ms
    } catch {
        return null;
    }
}

export async function getEspaceActif() {
    try {
        const row = await db
            .prepare(`SELECT espace_login, token, date FROM hubiflow_tokens ORDER BY date DESC LIMIT 1`)
            .get();
        if (!row) return { espaceLogin: null, tokenPresent: false, expire: false };

        const exp = decoderExpirationJWT(row.token);
        const expire = !!(exp && Date.now() > exp);
        return { espaceLogin: row.espace_login, tokenPresent: true, expire };
    } catch (e) {
        return { espaceLogin: null, tokenPresent: false, expire: false };
    }
}
