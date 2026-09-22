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
// côté Hubiflow).
//
// `referenceOriginale` (jamais reparsée d'une tentative précédente) + `tentative` (1, 2, 3...)
// explicites, plutôt que d'extraire un suffixe depuis la référence courante par regex — piège
// réel rencontré : la référence se termine déjà par -{n°lot} (ex. "PS-SERRIS-328"), indiscernable
// d'un vrai suffixe de collision pour une regex générique. Une première version bugguée a ainsi
// produit "PS-SERRIS-329" (lu comme suffixe 328+1) au lieu d'un vrai marqueur de nouvelle
// tentative — une référence qui ressemble à tort au lot 329. Préfixe "-r" (jamais un simple
// nombre) pour ne jamais pouvoir être confondu avec un numéro de lot ni avec le suffixe -2/-3
// de rendreUnique (collision interne, cas différent).
export async function forcerNouveauSuffixeReference(referenceOriginale, tentative, annonceId) {
    let candidate = `${referenceOriginale}-r${tentative}`;
    let n = tentative;
    while (await referenceDejaUtilisee(candidate, annonceId)) {
        n += 1;
        candidate = `${referenceOriginale}-r${n}`;
    }
    return candidate;
}

// Lit le promoteur Neuf reconnu depuis la table promoteurs_neuf (éditable par l'agence, voir
// db.js) — comparaison insensible à la casse/espaces (TRIM+LOWER des deux côtés) : contrairement
// au mapping en dur promoteurs.js (LMNP, comparaison stricte sur un id Otaree), une table saisie
// à la main par l'agence doit tolérer une variation de casse/espace sans provoquer une exclusion
// à tort. `actif = 1` uniquement : un promoteur désactivé se comporte comme non reconnu.
async function promoteurNeufDepuisLot(lot) {
    const nom = (lot?.program?.developer?.name || '').trim();
    if (!nom) return null;
    return await db
        .prepare(`SELECT * FROM promoteurs_neuf WHERE actif = 1 AND LOWER(TRIM(promoteur_nom)) = LOWER(?)`)
        .get(nom);
}

// Génère la référence Neuf pour une annonce, ou null si aucune des deux sources connues ne
// s'applique (référence reste à saisir manuellement sur l'écran de confirmation, jamais devinée) :
//
// 1. Promoteur reconnu (table promoteurs_neuf, éditable par l'agence — demande client 2026-09-22,
//    même principe que promoteurLmnpExclu pour le LMNP) : {Initiales}-{VILLE}-{n°lot}, même format
//    que le LMNP.
// 2. Sinon, référence de programme déjà configurée manuellement (programmes_reference,
//    mécanisme précédent, conservé comme filet de sécurité) : {référence}-{n°lot} — un programme
//    explicitement configuré par l'agence reste diffusé même si son promoteur n'est pas (encore)
//    dans la nouvelle table, pour ne jamais casser un programme déjà en fonctionnement au moment
//    où promoteurs_neuf est encore vide/incomplète.
//
// Un promoteur ni reconnu ni couvert par une référence de programme manuelle signifie plus que
// "référence à saisir à la main" : voir promoteurNeufExclu ci-dessous, qui exclut ces lots de
// l'auto-publication entièrement (même logique que promoteurLmnpExclu).
export async function genererReferenceNeuf(annonce, lot) {
    const ville = normaliserVille(annonce.ville);
    const numeroLot = annonce.reference;
    if (!ville || !numeroLot) return null;

    const promoteur = await promoteurNeufDepuisLot(lot);
    if (promoteur) {
        return await rendreUnique(`${promoteur.initiales}-${ville}-${numeroLot}`, annonce.id);
    }

    const programId = lot?.program?.id;
    if (programId) {
        const row = await db.prepare(`SELECT reference FROM programmes_reference WHERE program_id = ?`).get(programId);
        if (row) return await rendreUnique(`${row.reference}-${numeroLot}`, annonce.id);
    }

    return null;
}

// Un lot Neuf (non-LMNP) dont le promoteur n'est ni reconnu dans promoteurs_neuf ni couvert par
// une référence de programme configurée manuellement doit être exclu de l'auto-publication —
// demande explicite du client (2026-09-22), même principe que promoteurLmnpExclu pour le LMNP.
// Jamais appliqué à un lot LMNP (sa propre règle s'applique, indépendante).
export async function promoteurNeufExclu(lot) {
    if (estLotLmnp(lot)) return false;

    const programId = lot?.program?.id;
    if (programId) {
        const row = await db.prepare(`SELECT 1 FROM programmes_reference WHERE program_id = ?`).get(programId);
        if (row) return false;
    }

    return !(await promoteurNeufDepuisLot(lot));
}
