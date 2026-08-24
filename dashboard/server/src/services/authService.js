import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';

const DUREE_SESSION_JOURS = 30;
const NOM_COOKIE = 'sid';
const BCRYPT_ROUNDS = 12;

export async function hacherMotDePasse(motDePasse) {
    return bcrypt.hash(motDePasse, BCRYPT_ROUNDS);
}

export async function verifierMotDePasse(motDePasse, hash) {
    return bcrypt.compare(motDePasse, hash);
}

// Jeton de session = valeur du cookie directement (voir db.js, table sessions) — assez
// d'entropie (32 octets aléatoires) pour être infalsifiable, pas besoin de le signer/chiffrer
// en plus : sa seule utilité est de retrouver la ligne en base, qui fait foi.
function genererJetonSession() {
    return crypto.randomBytes(32).toString('hex');
}

export async function creerSession(utilisateurId) {
    const jeton = genererJetonSession();
    const expireLe = new Date(Date.now() + DUREE_SESSION_JOURS * 24 * 60 * 60 * 1000);
    await db.prepare(`INSERT INTO sessions (id, utilisateur_id, expire_le) VALUES (?, ?, ?)`).run(jeton, utilisateurId, expireLe.toISOString());
    return { jeton, expireLe };
}

export async function supprimerSession(jeton) {
    await db.prepare(`DELETE FROM sessions WHERE id = ?`).run(jeton);
}

// Coupe l'accès partout, immédiatement — utilisé quand un compte est désactivé, ou pour un
// "déconnecter cet employé de tous ses appareils" explicite.
export async function supprimerSessionsUtilisateur(utilisateurId) {
    await db.prepare(`DELETE FROM sessions WHERE utilisateur_id = ?`).run(utilisateurId);
}

// Résout un jeton de cookie vers l'utilisateur actif correspondant, ou null si absent/expiré/
// compte désactivé entre-temps — un seul aller-retour base (jointure), pas deux requêtes.
export async function resoudreUtilisateurDepuisJeton(jeton) {
    if (!jeton) return null;
    const row = await db
        .prepare(
            `SELECT u.id, u.email, u.nom
             FROM sessions s
             JOIN utilisateurs u ON u.id = s.utilisateur_id
             WHERE s.id = ? AND s.expire_le > CURRENT_TIMESTAMP AND u.actif = 1`
        )
        .get(jeton);
    return row || null;
}

// Options de cookie partagées entre la pose (login) et le retrait (logout) — sans `domain`
// explicite : le navigateur l'associe au domaine qu'il voit réellement (immo-76.vercel.app via
// le rewrite proxy vers Render, voir dashboard/vercel.json), pas à onrender.com. `secure` est
// systématique (le dashboard n'est jamais servi en HTTP réel, seulement en local pendant le dev
// où `req.secure` est de toute façon faux et le navigateur tolère un cookie non-secure sur
// localhost).
export function optionsCookie(estLocal, expireLe) {
    return {
        httpOnly: true,
        secure: !estLocal,
        sameSite: 'lax',
        path: '/',
        expires: expireLe,
    };
}

export { NOM_COOKIE };
