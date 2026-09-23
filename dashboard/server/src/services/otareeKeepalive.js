// Maintien de la session Otaree (2026-09-24) — répond à un incident réel : le refresh_token
// capturé par l'extension Chrome a une durée de vie limitée (mesurée à ~1h : capturé à 14:07,
// rejeté à 15:24 le 2026-09-23). Tant que rien ne le rafraîchissait entre deux runs, toute
// recherche ou tout traitement lancé après ce délai échouait avec "Session Otaree expirée", ce
// qui obligeait un humain à rouvrir Otaree avec l'extension active — inacceptable pour un outil
// censé tourner seul (recherches programmées, runs de plusieurs centaines de lots).
//
// Le rafraîchissement lui-même n'est pas nouveau : obtenirJwtFrais() le fait déjà à chaque usage,
// et persiste le refresh_token rotaté (voir refreshJwt, otareeSearchClient.js). Ce module ne fait
// qu'appeler ce même mécanisme à intervalle régulier pour que la session ne reste jamais inactive
// assez longtemps pour mourir.
//
// NB : si la durée de vie s'avérait FIXE (non glissante) côté Otaree, ce keepalive ne suffirait
// pas — l'état exposé ci-dessous (derniereErreur) le rendrait alors immédiatement visible dans
// l'interface plutôt que de le découvrir au lancement d'un run.
import { obtenirJwtFrais } from '../integrations/otareeSearchClient.js';

// Intervalle volontairement large devant la durée de vie observée (~1h) mais assez court pour
// qu'un échec ponctuel (réseau, 5xx Otaree) laisse plusieurs tentatives avant expiration réelle.
export const INTERVALLE_KEEPALIVE_MS = 15 * 60 * 1000;

let etat = {
    derniereTentativeLe: null,
    derniereReussiteLe: null,
    derniereErreur: null,
    nbEchecsConsecutifs: 0,
};

export function getEtatSessionOtaree() {
    return { ...etat, intervalleMs: INTERVALLE_KEEPALIVE_MS };
}

// Renseigné par les autres chemins (runs, recherches) quand ILS constatent un échec de jeton —
// évite que l'interface affiche "session OK" juste parce que le dernier keepalive, lancé avant
// l'expiration, avait réussi.
export function signalerEchecSessionOtaree(message) {
    etat.derniereErreur = message;
    etat.nbEchecsConsecutifs += 1;
}

export async function maintenirSessionOtaree() {
    etat.derniereTentativeLe = new Date().toISOString();
    try {
        await obtenirJwtFrais();
        etat.derniereReussiteLe = etat.derniereTentativeLe;
        etat.derniereErreur = null;
        etat.nbEchecsConsecutifs = 0;
        return { ok: true };
    } catch (e) {
        etat.derniereErreur = e.message;
        etat.nbEchecsConsecutifs += 1;
        // Jamais de throw : un échec de keepalive ne doit pas faire remonter un unhandledRejection
        // sur le process (voir index.js, ce module tourne dans un setInterval détaché).
        console.error(`[otaree-keepalive] échec (${etat.nbEchecsConsecutifs} d'affilée) : ${e.message}`);
        return { ok: false, erreur: e.message };
    }
}
