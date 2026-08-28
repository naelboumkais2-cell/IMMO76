import { db } from '../db.js';
import { promoteurDepuisLot } from './promoteurs.js';

// Bit du champ `law` (bitmask brut Otaree, un bit par dispositif fiscal) correspondant à LMNP —
// confirmé empiriquement (100% des lots d'une recherche filtrée uniquement sur LMNP ont
// law === 4, ce bit n'apparaissant dans aucune autre valeur observée en base), pas une valeur
// devinée à partir de l'ID utilisé dans le filtre de recherche.
const BIT_LOI_LMNP = 4;

function estLotLmnp(lot) {
    return typeof lot?.law === 'number' && (lot.law & BIT_LOI_LMNP) === BIT_LOI_LMNP;
}

function normaliserVille(ville) {
    return (ville || '').toUpperCase().replace(/\s+/g, '');
}

async function referenceDejaUtilisee(reference, annonceIdAExclure) {
    const row = await db
        .prepare(`SELECT 1 FROM annonces WHERE reference_generee = ? AND id != ? LIMIT 1`)
        .get(reference, annonceIdAExclure);
    return !!row;
}

// Génère la référence LMNP ({Initiales}-{VILLE}-{n°lot}) pour une annonce, ou null si la
// génération automatique ne s'applique pas (lot non-LMNP, promoteur non reconnu avec certitude,
// ou donnée manquante) — dans ce cas la référence reste à saisir manuellement sur l'écran de
// confirmation, jamais devinée. En cas de collision réelle (même promoteur, même ville, même n°
// de lot dans deux résidences différentes — cas confirmé existant en base), un suffixe -2, -3...
// est ajouté pour garantir l'unicité.
export async function genererReferenceLmnp(annonce, lot) {
    if (!estLotLmnp(lot)) return null;

    const promoteur = promoteurDepuisLot(lot);
    if (!promoteur) return null;

    const ville = normaliserVille(annonce.ville);
    const numeroLot = annonce.reference;
    if (!ville || !numeroLot) return null;

    const base = `${promoteur.initiales}-${ville}-${numeroLot}`;
    let candidate = base;
    let suffixe = 2;
    while (await referenceDejaUtilisee(candidate, annonce.id)) {
        candidate = `${base}-${suffixe}`;
        suffixe += 1;
    }
    return candidate;
}
