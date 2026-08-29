import { db } from '../db.js';
import { promoteurDepuisLot } from './promoteurs.js';
import { estLotLmnp } from './dispositifFiscal.js';

function normaliserVille(ville) {
    return (ville || '').toUpperCase().replace(/\s+/g, '');
}

async function referenceDejaUtilisee(reference, annonceIdAExclure) {
    const row = await db
        .prepare(`SELECT 1 FROM annonces WHERE reference_generee = ? AND id != ? LIMIT 1`)
        .get(reference, annonceIdAExclure);
    return !!row;
}

async function rendreUnique(base, annonceIdAExclure) {
    let candidate = base;
    let suffixe = 2;
    while (await referenceDejaUtilisee(candidate, annonceIdAExclure)) {
        candidate = `${base}-${suffixe}`;
        suffixe += 1;
    }
    return candidate;
}

// Mandat direct agence (INT) : d'après un collègue de la cliente, "nos mandats" (biens gérés en
// direct par l'agence, sans promoteur partenaire) se réfèrent uniquement en INT-ville-n°lot.
// Hypothèse de départ, PAS encore confirmée sur un vrai cas en base (aucun lot sans developer
// trouvé lors du diagnostic initial) — à vérifier dès qu'un exemple réel apparaît dans un import.
// Distinct d'un promoteur non reconnu (ex. "Edouard Denis") : ici program.developer est
// totalement absent du lot, pas juste absent du mapping promoteurs.js.
function estMandatDirect(lot) {
    return !lot?.program?.developer;
}

// Génère la référence LMNP ({Initiales}-{VILLE}-{n°lot}, ou INT-{VILLE}-{n°lot} pour un mandat
// direct) pour une annonce, ou null si la génération automatique ne s'applique pas (lot non-LMNP,
// promoteur non reconnu avec certitude, ou donnée manquante) — dans ce cas la référence reste à
// saisir manuellement sur l'écran de confirmation, jamais devinée. En cas de collision réelle
// (même promoteur, même ville, même n° de lot dans deux résidences différentes — cas confirmé
// existant en base), un suffixe -2, -3... est ajouté pour garantir l'unicité.
export async function genererReferenceLmnp(annonce, lot) {
    if (!estLotLmnp(lot)) return null;

    const ville = normaliserVille(annonce.ville);
    const numeroLot = annonce.reference;
    if (!ville || !numeroLot) return null;

    if (estMandatDirect(lot)) {
        return await rendreUnique(`INT-${ville}-${numeroLot}`, annonce.id);
    }

    const promoteur = promoteurDepuisLot(lot);
    if (!promoteur) return null;

    return await rendreUnique(`${promoteur.initiales}-${ville}-${numeroLot}`, annonce.id);
}
