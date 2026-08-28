// Mapping promoteur Otaree -> initiales, utilisé pour générer les références d'annonces LMNP
// (format {Initiales}-{ville}-{n°lot}, voir routes/génération à venir). Les 4 IDs ci-dessous sont
// confirmés avec certitude par sondage direct de l'API Otaree (nom lu dans program.developer.name
// des résultats, testé individuellement pour chaque ID) — voir aussi DEVELOPER_OPTIONS dans
// dashboard/client/src/components/ScraperControl.jsx, qui référence les mêmes 4 IDs.
export const PROMOTEURS = [
    { id: '/developers/dc7ffc55ea78', nom: 'Consultim', initiales: 'CST' },
    { id: '/developers/ab3f89e93847', nom: 'Pierre & Sens', initiales: 'PS' },
    { id: '/developers/3022d387a2e6', nom: 'CelaviPierre', initiales: 'CP' },
    { id: '/developers/3d765184da1e', nom: 'Pierre Loyers & Conseils', initiales: 'PLC' },
];

const PAR_ID = new Map(PROMOTEURS.map((p) => [p.id, p]));

// id attendu au format Otaree ("/developers/xxxxx", tel que renvoyé par program.developer['@id']
// dans un lot brut) — renvoie null si l'ID est inconnu (jamais un mapping deviné).
export function promoteurParId(id) {
    if (!id) return null;
    return PAR_ID.get(id) || null;
}

// Lit le promoteur directement depuis un lot Otaree brut (raw_data d'une annonce, tel que stocké
// par orchestrator.js) — renvoie null si le champ est absent ou l'ID inconnu.
export function promoteurDepuisLot(lot) {
    const id = lot?.program?.developer?.['@id'];
    return promoteurParId(id);
}
