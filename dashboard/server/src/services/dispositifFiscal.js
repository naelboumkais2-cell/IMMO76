// Codes `lawsKeys` (identifiants numériques accompagnés du libellé lisible `laws` sur chaque lot
// brut Otaree — ex. lawsKeys:[21], laws:["LMNP second marché"]) confirmés comme appartenant à la
// famille LMNP, lus directement sur de vrais lots, aucune supposition. Décision confirmée avec
// l'utilisateur (2026-08-30) : les 4 variantes comptent comme LMNP pour le routage vers le
// portail LMNP et la génération de référence automatique — pas seulement le code 2 "LMNP" seul.
const CODES_LMNP = [2, 21, 30, 32]; // LMNP, LMNP second marché, LMNP non géré, LMNP non géré réhabilité

// Volontairement basé sur lawsKeys (tableau d'entiers) plutôt que sur le bitmask `law` : les
// opérateurs bit à bit de JS tronquent tout opérande à 32 bits signés, ce qui donnait un résultat
// faux pour le code 32 (2^32 dépasse cette plage) — découvert en élargissant la détection LMNP
// au-delà du seul code 2. lawsKeys est un tableau simple, sans cette limite.
export function estLotLmnp(lot) {
    if (!Array.isArray(lot?.lawsKeys)) return false;
    return lot.lawsKeys.some((k) => CODES_LMNP.includes(k));
}
