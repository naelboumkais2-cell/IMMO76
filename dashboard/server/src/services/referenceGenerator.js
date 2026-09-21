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

// Correction suite à un retour client (2026-09-14) : l'hypothèse initiale "mandat direct = pas de
// promoteur du tout" était fausse — le promoteur est TOUJOURS renseigné chez Otaree pour ces lots,
// jamais absent (cohérent avec le fait que cette ancienne logique ne s'était d'ailleurs jamais
// déclenchée en production). Le vrai déclencheur INT est un promoteur précis : "La Centrale du
// LMNP" (id Otaree /developers/bec3d1402a8a, orthographe/casse vérifiées sur un vrai lot avant de
// coder cette comparaison — voir diag temporaire du 2026-09-14). Comparaison sur le nom (pas
// l'id) à la demande explicite du client, trim() par prudence contre un espace parasite.
function estCentraleLmnp(lot) {
    return (lot?.program?.developer?.name || '').trim() === 'La Centrale du LMNP';
}

// Génère la référence LMNP ({Initiales}-{VILLE}-{n°lot}, ou INT-{VILLE}-{n°lot} pour "La Centrale
// du LMNP") pour une annonce, ou null si la génération automatique ne s'applique pas (lot non-LMNP,
// promoteur non reconnu, ou donnée manquante) — dans ce cas la référence reste à saisir
// manuellement sur l'écran de confirmation, jamais devinée. Un promoteur non reconnu (ni un des 4
// partenaires connus, ni "La Centrale du LMNP") signifie plus que "référence à saisir à la main" :
// voir promoteurLmnpExclu ci-dessous, utilisé par orchestrator.js pour exclure ces lots de
// l'auto-publication entièrement (demande explicite du client — "on ne le diffusera pas"). En cas
// de collision réelle (même promoteur, même ville, même n° de lot dans deux résidences
// différentes — cas confirmé existant en base), un suffixe -2, -3... est ajouté pour garantir
// l'unicité.
export async function genererReferenceLmnp(annonce, lot) {
    if (!estLotLmnp(lot)) return null;

    const ville = normaliserVille(annonce.ville);
    const numeroLot = annonce.reference;
    if (!ville || !numeroLot) return null;

    if (estCentraleLmnp(lot)) {
        return await rendreUnique(`INT-${ville}-${numeroLot}`, annonce.id);
    }

    const promoteur = promoteurDepuisLot(lot);
    if (!promoteur) return null;

    return await rendreUnique(`${promoteur.initiales}-${ville}-${numeroLot}`, annonce.id);
}

// Un lot LMNP dont le promoteur n'est ni l'un des 4 partenaires reconnus (promoteurs.js) ni "La
// Centrale du LMNP" doit être exclu de l'auto-publication (jamais proposé sur l'écran de
// confirmation ni publié automatiquement) — demande explicite du client : ces promoteurs tiers ne
// doivent pas être diffusés du tout, pas juste laissés avec une référence vide à compléter à la
// main. Le lot reste importé en base normalement (visible/traitable manuellement si besoin, voir
// Supervision) — voir orchestrator.js, autoGenererEtPublier, qui filtre les candidats avec ceci.
// Ne s'applique qu'aux lots LMNP : un lot Neuf sans référence de programme connue garde son
// comportement inchangé (référence à saisir manuellement, jamais exclu).
export function promoteurLmnpExclu(lot) {
    if (!estLotLmnp(lot)) return false;
    if (estCentraleLmnp(lot)) return false;
    return !promoteurDepuisLot(lot);
}

// Récupération après un rejet Hubiflow "Cette référence existe déjà" (2026-09-21) : notre
// vérification d'unicité (referenceDejaUtilisee) ne regarde que NOTRE base, jamais l'inventaire
// réel de Hubiflow — une référence peut donc y être déjà prise par une annonce qu'on ne suit plus
// (ex. un programme déjà testé puis supprimé de notre base sans garantie de dépublication réussie
// côté Hubiflow). Contrairement à rendreUnique (appelée à la génération initiale, quand la
// référence de base n'existe encore nulle part chez nous), on force ici un suffixe strictement
// supérieur à celui déjà présent — sinon rendreUnique(base, id) renverrait la même référence que
// celle qui vient d'être rejetée, puisqu'elle est déjà "unique" du point de vue de notre seule base.
export async function forcerNouveauSuffixeReference(referenceActuelle, annonceId) {
    const m = referenceActuelle.match(/^(.*)-(\d+)$/);
    const base = m ? m[1] : referenceActuelle;
    let suffixe = m ? parseInt(m[2], 10) + 1 : 2;
    let candidate = `${base}-${suffixe}`;
    while (await referenceDejaUtilisee(candidate, annonceId)) {
        suffixe += 1;
        candidate = `${base}-${suffixe}`;
    }
    return candidate;
}

// Génère la référence Neuf ({référence de programme}-{n°lot}) pour une annonce, ou null si le
// programme du lot n'a pas encore de référence connue (voir programmes_reference, table saisie
// manuellement par l'agence — table de routes/parametres.js) — dans ce cas la référence reste à
// saisir manuellement sur l'écran de confirmation, exactement comme pour un lot LMNP sans
// promoteur reconnu. Clé program.id (voir champsConnusDepuisLot pour d'autres usages de cet
// identifiant Otaree stable) : tous les lots d'une même résidence partagent la même référence
// automatiquement, y compris sur une future recherche qui retrouve ce même programme.
export async function genererReferenceNeuf(annonce, lot) {
    const programId = lot?.program?.id;
    const numeroLot = annonce.reference;
    if (!programId || !numeroLot) return null;

    const row = await db.prepare(`SELECT reference FROM programmes_reference WHERE program_id = ?`).get(programId);
    if (!row) return null;

    return await rendreUnique(`${row.reference}-${numeroLot}`, annonce.id);
}
